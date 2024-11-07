import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { File, LoaderCircle, X } from 'lucide-react';
import { downloadDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/api/dialog';
import { appWindow } from "@tauri-apps/api/window";
import { invoke, path } from '@tauri-apps/api';
import { BaseDirectory, exists, readTextFile } from '@tauri-apps/api/fs';
import { z, ZodError } from "zod";
import { toast } from 'sonner';

const AssetBundleSchema = z.object({
  performance: z.enum(['excellent', 'good', 'medium', 'poor', 'verypoor']),
  unityVersion: z.string()
});

export const MetadataSchema = z.object({
  name: z.string(),
  blueprintId: z.string(),
  assetBundles: z.object({
    windows: AssetBundleSchema.optional(),
    android: AssetBundleSchema.optional(),
    ios: AssetBundleSchema.optional()
  })
});

export type Metadata = z.infer<typeof MetadataSchema>;

const thirdBundleExtname = "3b";

const AssetBundleInput = (props: { onChange: (bundle: Metadata, unpackPath: string) => void, onError: (msg: string) => void; }) => {
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let unlisten;

    const setupFileDropListener = async () => {
      unlisten = await appWindow.onFileDropEvent((event) => {
        if (event.payload.type === 'hover') {
          const bundlePaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith("." + thirdBundleExtname));
          if (bundlePaths.length > 0) {
            setDragActive(true);
          } else {
            setDragActive(false);
          }
        } else if (event.payload.type === 'drop') {
          const bundlePaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith("." + thirdBundleExtname));

          // if multiple use the first path and ignore the others
          if (bundlePaths.length > 0) {
            handleBundle(bundlePaths[0]);
          }
          setDragActive(false);
        } else {
          setDragActive(false);
        }
      });
    };

    setupFileDropListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  async function handleBundle(bundlePath: string) {
    setLoading(true);
    try {
      // absolute path
      const unpackPath = await invoke("unpack_bundle", { path: bundlePath }) as string;
      const metadataPath = await join(unpackPath, "metadata.json");
      const metadataText = await readTextFile(metadataPath);
      const metadata = MetadataSchema.parse(JSON.parse(metadataText));

      // resolve files
      const thumbnailPath = await join(unpackPath, "thumbnail.png");
      if (await exists(thumbnailPath)) {
        metadata.thumbnail = thumbnailPath;
      } else {
        throw new Error("thumbnail.png not found");
      }

      for (const [platform, bundle] of Object.entries(metadata.assetBundles)) {
        const assetBundlePath = await join(unpackPath, `${platform}.vrca`);
        const assetBundleZPath = await join(unpackPath, `${platform}.vrcaz`);
        if (await exists(assetBundleZPath)) {
          bundle.path = assetBundleZPath;
        } else if (await exists(assetBundlePath)) {
          bundle.path = assetBundlePath;
        } else {
          throw new Error(`Asset bundle for ${platform} not found`);
        }
      }
      // setLoading(false); // don't stop loading, let unmount handle it for smooth transition
      props.onChange(metadata, unpackPath);
    } catch (e) {
      let description;
      if (e instanceof ZodError) {
        description = "Metadata invalid";
      } else {
        description = e.message;
      }
      toast.error("Loading bundle failed", { description });
      console.error(e);
      setLoading(false);
    }
  }


  const handleClick = async (e) => {
    const selected = await open({
      defaultPath: await downloadDir(),
      filters: [
        {
          name: "Third Avatar Bundle",
          extensions: [thirdBundleExtname]
        }
      ]
    });
    if (!selected) return;
    if (Array.isArray(selected)) {
      // ignore others and pick the first one
      handleBundle(selected[0]);
    } else {
      handleBundle(selected);
    }
  };

  return (
    <div className={`flex justify-center items-center gap-2 px-4 py-2 min-h-60 border rounded  transition-shadow ${dragActive && 'bg-zinc-900 shadow-2xl shadow-black '}`}>
      {loading ?
        <LoaderCircle className="animate-spin size-12" />
        :
        <>
          <File className='text-zinc-500' />
          <p className=''>Drag and drop a <strong>.{thirdBundleExtname}</strong> file or</p>
          <Button type="button" variant='secondary' onClick={handleClick} className="bg-gradient-to-br from-zinc-700 to-zinc-900 hover:from-zinc-600">Select Third Avatar Bundle</Button>
        </>
      }
    </div>
  );
};

export default AssetBundleInput;