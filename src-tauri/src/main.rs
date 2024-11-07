#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::{
    fs::File,
    io::{BufReader, SeekFrom, Write},
    path::PathBuf,
    str::FromStr,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use bundle::{AssetBundleDecoder, AssetBundleEncoder};
use keyring::Entry;
use librsync::Signature;
use md5::{Digest, Md5};
use rand::Rng;
use reqwest::{header::*, Body};
use serde::{Deserialize, Serialize};
use tauri::PathResolver;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::{
    codec::{BytesCodec, FramedRead},
    io::ReaderStream,
};
use zip::ZipArchive;

//   mod file_watcher;
mod upload;
mod bundle;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Token {
    auth: String,
    two_factor: String,
}

#[tauri::command]
fn save_token(username: String, token: Token) -> Result<(), String> {
    let entry = Entry::new("third_vrchat_token", &username).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&token).map_err(|e| e.to_string())?;
    entry.set_password(&json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_token(username: String) -> Result<Option<Token>, String> {
    let entry = Entry::new("third_vrchat_token", &username).map_err(|e| e.to_string())?;
    let res = entry.get_password();
    match res {
        Ok(json) => serde_json::from_str::<Token>(&json)
            .map(|t| Some(t))
            .map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn delete_token(username: String) -> Result<(), String> {
    let entry = Entry::new("third_vrchat_token", &username).map_err(|e| e.to_string())?;
    entry.delete_credential().map_err(|e| e.to_string())
}

#[tauri::command]
fn md5_digest_file(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let hash = Md5::digest(&data);
    let hashb64 = STANDARD.encode(&hash);
    Ok(hashb64)
}

#[tauri::command]
async fn signature_generate_from_file(
    path: String,
    output: String
) -> Result<(), String> {
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut signature = Signature::with_options(&file, 2048, 32, librsync::SignatureType::Blake2)
        .map_err(|e| e.to_string())?;
    let mut output_file = std::fs::File::create(&output).map_err(|e| e.to_string())?;
    std::io::copy(&mut signature, &mut output_file).map_err(|e| e.to_string())?;
    output_file.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn unpack_bundle(app_handle: tauri::AppHandle, path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let file = File::open(&path).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);
        let mut archive = ZipArchive::new(reader).map_err(|e| e.to_string())?;
        let app_dir = app_handle
            .path_resolver()
            .app_data_dir()
            .ok_or("No data dir")?;

        let mut tmp = PathBuf::from("bundles");

        let random_bytes: [u8; 16] = rand::thread_rng().gen();
        let target_dir = random_bytes
            .iter()
            .map(|byte| format!("{:02x}", byte))
            .collect::<String>();
        tmp.push(target_dir);

        let dst = app_dir.join(&tmp);

        std::fs::create_dir_all(&dst).map_err(|err| err.to_string())?;
        match archive.extract(&dst) {
            Ok(_) => Ok(dst.to_string_lossy().into_owned()),
            Err(err) => {
                std::fs::remove_dir_all(&dst).map_err(|err| err.to_string())?;
                Err(err.to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn transcode_bundle(path: String, output: String) -> Result<(), String> {
    let input_file = File::open(&path).map_err(|err| err.to_string())?;
    let reader = BufReader::new(input_file);
    let decoder = AssetBundleDecoder::new(reader);
    let mut bundle = decoder.decode().map_err(|err| err.to_string())?;

    bundle.set_blocks_lzma();

    let output_file = File::create(&output).map_err(|err| err.to_string())?;
    let writer = std::io::BufWriter::new(output_file);
    let encoder = AssetBundleEncoder::new(writer);
    encoder.encode(&bundle).map_err(|err| err.to_string())?;
    Ok(())
}

const USER_AGENT: &str = "Third Uploader/0.1.0 third3dcom@gmail.com";

#[tauri::command]
async fn upload_file(
    url: String,
    path: String,
    start: u64,
    length: u64,
) -> Result<Option<String>, String> {
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|err| err.to_string())?;
    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|err| err.to_string())?;
    let stream = ReaderStream::new(file.take(length));

    let client = reqwest::Client::new();
    let request = client
        .put(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(CONTENT_LENGTH, length.to_string())
        .body(Body::wrap_stream(stream));

    let response = request.send().await.map_err(|err| err.to_string())?;
    if response.status().is_success() {
        let h = response.headers().get("etag");
        let etag = if let Some(etag) = h {
            Some(etag.to_str()
                    .map(|v| v.to_owned())
                    .map_err(|err| err.to_string())?)
        } else {
            None
        };
        Ok(etag)
    } else {
        Err(format!(
            "{}: {}",
            response.status().as_str(),
            response.text().await.unwrap_or_default()
        ))
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs_extra::init())
        .plugin(upload::init())
        .invoke_handler(tauri::generate_handler![
            save_token,
            load_token,
            delete_token,
            md5_digest_file,
            signature_generate_from_file,
            unpack_bundle,
            upload_file,
            transcode_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
