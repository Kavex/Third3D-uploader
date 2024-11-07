use liblzma::read::XzDecoder;
use liblzma::stream::{self, Filters, Stream};
use liblzma::write::XzEncoder;
use lz4_flex::block::DecompressError;
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Chain, Cursor, Read, Seek, SeekFrom, Write};
use std::time::Instant;
use thiserror::Error;

// TODO: Enforce limits
const PC_COMPRESSED_SIZE_LIMIT: usize = 200 * 1024 * 1024;
const PC_UNCOMPRESSED_SIZE_LIMIT: usize = 500 * 1024 * 1024;
const ANDROID_COMPRESSED_SIZE_LIMIT: usize = 10 * 1024 * 1024;
const ANDROID_UNCOMPRESSED_SIZE_LIMIT: usize = 40 * 1024 * 1024;

#[derive(Error, Debug)]
pub enum BundleError {
    #[error("IO error: {0}")]
    Io(#[from] io::Error),
    #[error("Unsupported bundle type: {0}")]
    UnsupportedBundle(String),
    #[error("Invalid data: {0}")]
    InvalidData(String),
    #[error("Decompress error")]
    Decompress(#[from] DecompressError),
    #[error("LZMA error")]
    LZMA(#[from] liblzma::stream::Error),
    #[error("File not in Directory Info")]
    DirNotFound,
    #[error("More than one block in AssetBundle")]
    MoreThanOneBlock,
}

type Result<T> = std::result::Result<T, BundleError>;

#[derive(Debug, PartialEq, Eq)]
struct BlockInfo {
    uncompressed_size: u32,
    compressed_size: u32,
    flags: u16,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DirectoryInfo {
    offset: u64,
    size: u64,
    flags: u32,
    pub path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct AssetBundle {
    signature: String,
    version: u32,
    unity_version: String,
    unity_revision: String,
    size: u64,
    compressed_block_info_size: u32,
    uncompressed_block_info_size: u32,
    flags: u32,
    blocks_info: Vec<BlockInfo>,
    directory_info: Vec<DirectoryInfo>,
    block: Vec<u8>,
}

impl AssetBundle {
    pub fn set_blocks_lzma(&mut self) {
        for block in &mut self.blocks_info {
            block.flags = (block.flags & !0x3F) | 1;
        }
    }

}

pub struct AssetBundleDecoder<R: Read + Seek> {
    inner: R,
}

impl<R: Read + Seek> AssetBundleDecoder<R> {
    pub fn new(reader: R) -> Self {
        Self { inner: reader }
    }

    pub fn decode(mut self) -> Result<(AssetBundle)> {
        let signature = self.inner.read_string()?;
        if signature != "UnityFS" {
            return Err(BundleError::UnsupportedBundle(signature));
        }

        let version = self.inner.read_u32()?;
        let unity_version = self.inner.read_string()?;
        let unity_revision = self.inner.read_string()?;

        let size = self.inner.read_u64()?;
        let compressed_block_info_size = self.inner.read_u32()?;
        let uncompressed_block_info_size = self.inner.read_u32()?;
        let flags = self.inner.read_u32()?;

        if version >= 7 {
            self.inner.align(16)?;
        }

        if flags & 0x80 != 0 {
            // kArchiveBlocksInfoAtTheEnd
            self.inner
                .seek(SeekFrom::End(-(compressed_block_info_size as i64)))?;
        }

        let block_info_bytes = self.read_decompress(
            compressed_block_info_size,
            uncompressed_block_info_size,
            flags,
        )?;

        let mut block_info_reader = Cursor::new(block_info_bytes);

        // Skip hash
        block_info_reader.seek(SeekFrom::Current(16))?;

        // Read blocks info

        let blocks_info_count = block_info_reader.read_u32()?;
        let mut blocks_info = Vec::with_capacity(blocks_info_count as usize);
        for _ in 0..blocks_info_count {
            let uncompressed_size = block_info_reader.read_u32()?;
            let compressed_size = block_info_reader.read_u32()?;
            let flags = block_info_reader.read_u16()?;
            blocks_info.push(BlockInfo {
                uncompressed_size,
                compressed_size,
                flags,
            });
        }

        // Read directory info
        let directory_info_count = block_info_reader.read_u32()?;
        let mut directory_info = Vec::with_capacity(directory_info_count as usize);
        for _ in 0..directory_info_count {
            let offset = block_info_reader.read_u64()?;
            let size = block_info_reader.read_u64()?;
            let flags = block_info_reader.read_u32()?;
            let path = block_info_reader.read_string()?;
            directory_info.push(DirectoryInfo {
                offset,
                size,
                flags,
                path,
            });
        }

        if flags & 0x200 != 0 {
            self.inner.align(16)?;
        }

        if blocks_info.len() != 1 {
            return Err(BundleError::MoreThanOneBlock);
        }

        let block_info = &blocks_info[0];

        let block = self.read_decompress(
            block_info.compressed_size,
            block_info.uncompressed_size,
            block_info.flags.into(),
        )?;

        Ok(AssetBundle {
            signature,
            version,
            unity_version,
            unity_revision,
            size,
            compressed_block_info_size,
            uncompressed_block_info_size,
            flags,
            blocks_info,
            directory_info,
            block,
        })
    }

    fn read_decompress(
        &mut self,
        compressed_size: u32,
        uncompressed_size: u32,
        flags: u32,
    ) -> Result<Vec<u8>> {
        let compression_type = flags & 0x3F;

        match compression_type {
            1 => {
                // LZMA
                let mut header = [0u8; 5];
                self.inner.read_exact(&mut header)?;
                let stream = Stream::new_raw_decoder(Filters::new().lzma1_properties(&header)?)?;
                let mut decoder = XzDecoder::new_stream(&mut self.inner, stream);

                let mut decompressed = Vec::with_capacity(uncompressed_size as usize);
                decoder.read_to_end(&mut decompressed)?;

                Ok(decompressed)
            }
            2 | 3 => {
                // LZ4, LZ4HC
                let mut data = Vec::with_capacity(compressed_size as usize);
                unsafe {
                    data.set_len(compressed_size as usize);
                }
                self.inner.read_exact(&mut data)?;
                Ok(lz4_flex::decompress(&data, uncompressed_size as usize)?)
            }
            4 => {
                Ok(zstd::decode_all(&mut self.inner)?)
            }
            _ => {
                let mut data = Vec::with_capacity(compressed_size as usize);
                unsafe {
                    data.set_len(compressed_size as usize);
                }
                self.inner.read_exact(&mut data)?;
                Ok(data)
            }
        }
    }
}

pub struct AssetBundleEncoder<W: Write + Seek> {
    inner: W,
}

impl<W: Write + Seek> AssetBundleEncoder<W> {
    pub fn new(inner: W) -> Self {
        Self { inner }
    }

    pub fn encode(mut self, bundle: &AssetBundle) -> Result<()> {
        if (bundle.blocks_info.len() != 1) {
            return Err(BundleError::MoreThanOneBlock);
        }

        // Write header
        self.inner.write_string(&bundle.signature)?;
        self.inner.write_u32(bundle.version)?;
        self.inner.write_string(&bundle.unity_version)?;
        self.inner.write_string(&bundle.unity_revision)?;

        // Placeholder for size
        let size_pos = self.inner.stream_position()?;
        self.inner.write_u64(0)?;


        let compressed_block =
            self.compress(&bundle.block, (bundle.blocks_info[0].flags & 0x3F).into())?;


        // Create and compress block info
        let block_info = {
            let mut writer = Cursor::new(Vec::new());

            // Placeholder for hash (16 bytes of zeros)
            writer.write_all(&[0u8; 16])?;

            // Write blocks info
            writer.write_u32(1)?; // Only one block
            writer.write_u32(bundle.block.len() as u32)?;
            writer.write_u32(compressed_block.len() as u32)?;
            writer.write_all(&(bundle.blocks_info[0].flags).to_be_bytes())?;

            // Write directory info
            writer.write_u32(bundle.directory_info.len() as u32)?;

            // Assumes files didn't change in size
            for dir_info in &bundle.directory_info {
                writer.write_u64(dir_info.offset)?;
                writer.write_u64(dir_info.size)?;
                writer.write_u32(dir_info.flags)?;
                writer.write_string(&dir_info.path)?;
            }

            writer.into_inner()
        };
        let compressed_block_info = self.compress(&block_info, bundle.flags & 0x3F)?;

        self.inner.write_u32(compressed_block_info.len() as u32)?;
        self.inner.write_u32(block_info.len() as u32)?;
        self.inner.write_u32(bundle.flags)?;

        // Alignment
        if bundle.version >= 7 {
            self.inner.align(16)?;
        }

        // Write block info and data
        self.inner.write_all(&compressed_block_info)?;

        if bundle.flags & 0x200 != 0 {
            self.inner.align(16)?;
        }


        self.inner.write_all(&compressed_block)?;


        // Write final size
        let end_pos = self.inner.stream_position()?;
        self.inner.seek(SeekFrom::Start(size_pos))?;
        self.inner.write_u64(end_pos)?;

        // Write to file
        self.inner.flush()?;

        Ok(())
    }

    fn compress(&mut self, data: &[u8], compression_type: u32) -> Result<Vec<u8>> {
        match compression_type {
            1 => {
                let mut options = stream::LzmaOptions::new_preset(6)?;
                options.dict_size(524288); // Unity dict size
                                           // .literal_context_bits(3)
                                           // .position_bits(2)
                                           // .literal_position_bits(0);
                let stream = Stream::new_lzma_encoder(&options)?;
                let mut encoder = XzEncoder::new_stream(Vec::new(), stream);

                // Compress data
                encoder.write_all(data)?;
                let compressed = encoder.finish()?;

                let mut compressed_unity_format = Vec::new();
                compressed_unity_format.extend_from_slice(&compressed[..5]); // append props and dict size
                                                                             // skipping uncompressed size field (unity includes it in block info)
                compressed_unity_format.extend_from_slice(&compressed[13..]); // append compressed data

                Ok(compressed_unity_format)
            }
            2 | 3 => {
                // LZ4, LZ4HC
                Ok(lz4_flex::compress(data))
            }
            _ => Ok(data.to_vec()),
        }
    }
}

trait ReadExt: Read {
    fn read_string(&mut self) -> io::Result<String> {
        let mut result = Vec::new();
        loop {
            let mut buf = [0u8; 1];
            self.read_exact(&mut buf)?;
            if buf[0] == 0 {
                break;
            }
            result.push(buf[0]);
        }
        Ok(String::from_utf8_lossy(&result).into_owned())
    }

    fn read_u16(&mut self) -> io::Result<u16> {
        let mut buf = [0u8; 2];
        self.read_exact(&mut buf)?;
        Ok(u16::from_be_bytes(buf))
    }

    fn read_u32(&mut self) -> io::Result<u32> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)?;
        Ok(u32::from_be_bytes(buf))
    }

    fn read_u64(&mut self) -> io::Result<u64> {
        let mut buf = [0u8; 8];
        self.read_exact(&mut buf)?;
        Ok(u64::from_be_bytes(buf))
    }
}

impl<R: Read> ReadExt for R {}

trait AlignReadExt: Read + Seek {
    fn align(&mut self, alignment: u64) -> io::Result<()> {
        let current_position = self.stream_position()?;
        let aligned_position = (current_position + alignment - 1) & !(alignment - 1);
        self.seek(SeekFrom::Start(aligned_position))?;
        Ok(())
    }
}

impl<R: Read + Seek> AlignReadExt for R {}

trait WriteExt: Write {
    fn write_string(&mut self, s: &str) -> io::Result<()> {
        self.write_all(s.as_bytes())?;
        self.write_all(&[0])?;
        Ok(())
    }

    fn write_u16(&mut self, value: u16) -> io::Result<()> {
        self.write_all(&value.to_be_bytes())
    }

    fn write_u32(&mut self, value: u32) -> io::Result<()> {
        self.write_all(&value.to_be_bytes())
    }

    fn write_u64(&mut self, value: u64) -> io::Result<()> {
        self.write_all(&value.to_be_bytes())
    }
}

impl<W: Write> WriteExt for W {}

trait AlignWriteExt: Write + Seek {
    fn align(&mut self, alignment: u64) -> io::Result<()> {
        let current_position = self.stream_position()?;
        let aligned_position = (current_position + alignment - 1) & !(alignment - 1);
        self.seek(SeekFrom::Start(aligned_position))?;
        Ok(())
    }
}

impl<W: Write + Seek> AlignWriteExt for W {}