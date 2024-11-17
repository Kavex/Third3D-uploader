import { useState, useEffect, MouseEvent } from 'react';
import { Button } from "@/components/ui/button";
import { File, LoaderCircle, X } from 'lucide-react';
import { downloadDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/api/dialog';
import { appWindow } from "@tauri-apps/api/window";
import { UnlistenFn } from '@tauri-apps/api/event';

export function FileInput(props: { extension: string, onChange: (path: string) => void; loading?: boolean; }) {
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    if (props.loading) return;

    let unlisten: UnlistenFn;
    const setupFileDropListener = async () => {
      unlisten = await appWindow.onFileDropEvent((event) => {
        if (event.payload.type === 'hover') {
          const bundlePaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith("." + props.extension));
          if (bundlePaths.length > 0) {
            setDragActive(true);
          } else {
            setDragActive(false);
          }
        } else if (event.payload.type === 'drop') {
          const bundlePaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith("." + props.extension));

          // if multiple use the first path and ignore the others
          if (bundlePaths.length > 0) {
            handleFile(bundlePaths[0]);
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
  }, [props.loading]);


  const handleClick = async (e: MouseEvent) => {
    const selected = await open({
      defaultPath: await downloadDir(), filters:
        [{
          name: "Third Avatar Bundle",
          extensions: [props.extension]
        }]
    });
    if (!selected) return;
    if (Array.isArray(selected)) {
      // ignore others and pick the first one
      handleFile(selected[0]);
    } else {
      handleFile(selected);
    }
  };

  const handleFile = (path: string) => {
    props.onChange(path);
  };

  return (
    <div className={`flex justify-center items-center gap-2 px-4 py-2 min-h-60 border rounded  transition-shadow ${dragActive && 'bg-zinc-900 shadow-2xl shadow-black '}`}>
      {props.loading ?
        <LoaderCircle className="animate-spin size-12" />
        :
        <>
          <File className='text-zinc-500' />
          <p className=''>Drag and drop a <strong>.{props.extension}</strong> file or</p>
          <Button type="button" variant='secondary' onClick={handleClick} className="bg-gradient-to-br from-zinc-700 to-zinc-900 hover:from-zinc-600">Select Third Avatar Bundle</Button>
        </>
      }
    </div>
  );
};

// export default AssetBundleInput;