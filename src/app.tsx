import { useEffect, useState } from 'react';
import { ThemeProvider } from './components/theme-provider';
import thirdLogo from "./assets/third-logo.svg";
import { Button } from './components/ui/button';
import vrchatLogo from "./assets/VRC_Logo.svg";
import AssetBundleInput, { Metadata } from './bundle-input';
import Android from "./assets/android.svg?react";
import Windows from "./assets/windows.svg?react";
import Apple from "./assets/apple.svg?react";
import excellent from './assets/excellent.png';
import good from './assets/good.png';
import medium from './assets/medium.png';
import poor from './assets/poor.png';
import veryPoor from './assets/very-poor.png';
import { LogOut, Upload } from 'lucide-react';
import { AuthProvider, useAuth } from './auth';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { removeDir } from '@tauri-apps/api/fs';
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip';
import { appWindow } from '@tauri-apps/api/window';
import { uploadAvatar } from './upload-avatar';
import { convertFileSrc } from '@tauri-apps/api/tauri';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';
import { VRChatError } from './api';
import { open } from '@tauri-apps/api/shell';


function AssetBundleInfo(props: { platform: string, performance: string; }) {
  let perfImg: string;
  switch (props.performance) {
    case 'excellent': perfImg = excellent; break;
    case 'good': perfImg = good; break;
    case 'medium': perfImg = medium; break;
    case 'poor': perfImg = poor; break;
    case 'verypoor': perfImg = veryPoor; break;
    default: throw new Error('Unknown performance rating');
  }

  let perfTxt: string;
  switch (props.performance) {
    case 'excellent': perfTxt = "Excellent"; break;
    case 'good': perfTxt = "Good"; break;
    case 'medium': perfTxt = "Medium"; break;
    case 'poor': perfTxt = "Poor"; break;
    case 'verypoor': perfTxt = "Very Poor"; break;
    default: throw new Error('Unknown performance rating');
  }

  let platTxt: string;
  switch (props.platform) {
    case "windows": platTxt = "Windows"; break;
    case "android": platTxt = "Android"; break;
    case "ios": platTxt = "iOs"; break;
    default: throw new Error('Unknown platform');
  }

  let platIcon: JSX.Element;
  switch (props.platform) {
    case "windows": platIcon = <Windows className="w-7 text-white" fill="currentColor" />; break;
    case "android": platIcon = <Android className="w-8 text-white" fill="currentColor" />; break;
    case "ios": platIcon = <Apple className="h-7 text-white" fill="currentColor" />; break;
    default: throw new Error('Unknown platform');
  }

  return <div className='flex items-center ml-1.5'>
    <Tooltip>
      <TooltipTrigger>
        {platIcon}
      </TooltipTrigger>
      <TooltipContent>
        <p>{platTxt}</p>
      </TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger>
        <img src={perfImg} className="size-10" />
      </TooltipTrigger>
      <TooltipContent>
        <p>{perfTxt}</p>
      </TooltipContent>
    </Tooltip>
  </div>;
}


function Avatar(props: { metadata: Metadata; onFinish: () => void; }) {
  const { user, authToken, openLogin } = useAuth();
  const [uploading, setUploading] = useState(false);
  const bundles = props.metadata.assetBundles;

  const handleUpload = () => {
    const upload = async (authToken) => {
      // TODO: progress, abort
      setUploading(true);
      const id = toast.loading("Uploading Avatar...");
      try {
        await uploadAvatar(authToken, props.metadata);
        toast.success("Upload successful", {
          id,
          description: props.metadata.name,
          duration: Infinity,
          closeButton: true
        });
        props.onFinish();
      } catch (e) {
        let description = e.message;
        if (e instanceof VRChatError) {
          if (e.data.error.status_code === 401) {
            description = "Please logout and relog into your VRChat account";
          }
        }
        toast.error("Upload failed", {
          id,
          description,
          duration: Infinity,
          closeButton: true
        });
        console.error(e);
      }
      setUploading(false);
    };

    if (user) {
      upload(authToken);
    } else {
      // login handler gets removed, when auth is cancelled. 
      // upload can only be cancelled after auth is cancelled,
      // therefore no need to remove login handler when upload is cancelled
      openLogin(upload);
    }
  };

  const handleCancel = () => {
    props.onFinish();
  };

  return <><div className='flex flex-col gap-6 items-center mt-6'>
    <h1 className='text-3xl font-semibold'>{props.metadata.name}</h1>
    <img src={convertFileSrc(props.metadata.thumbnail)} className='aspect-[4/3] w-96 shadow-2xl shadow-black rounded-xl object-cover' />
    <TooltipProvider>
      <div className='flex justify-center items-center gap-2'>
        {bundles.windows && <>
          <AssetBundleInfo platform="windows" performance={bundles.windows.performance} />
          {(bundles.android || bundles.ios) && <div className='w-0.5 bg-zinc-700 self-stretch' />}
        </>
        }
        {bundles.android && <>
          <AssetBundleInfo platform="android" performance={bundles.android.performance} />
          {bundles.ios && <div className='w-0.5 bg-zinc-700 self-stretch' />}
        </>}
        {bundles.ios &&
          <AssetBundleInfo platform="ios" performance={bundles.ios.performance} />
        }
      </div>
      <div className='flex items-center gap-2'>
        <Button variant='outline' onClick={handleCancel} disabled={uploading}>Cancel</Button>
        <Button onClick={handleUpload} className='pl-3 transition-shadow hover:shadow-lg hover:shadow-white/50' disabled={uploading}><Upload className="h-4 mr-2" />Upload</Button>
      </div>
    </TooltipProvider>
  </div>
    {uploading && <div className='absolute w-screen h-screen top-0 left-0 -z-10 bg-gradient-to-br from-zinc-700 to-black animate-fade' />}
  </>;
}


function User() {
  const { user, openLogin, logout } = useAuth();

  if (user) {
    const imgUrl = user.profilePicOverrideThumbnail ? user.profilePicOverrideThumbnail : user.currentAvatarThumbnailImageUrl;
    return <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' className='flex items-center h-auto gap-4 px-6 py-3 hover:bg-transparent hover:bg-gradient-to-br hover:from-zinc-700 hover:to-transparent'>
            <img src={imgUrl} className='size-12 object-cover rounded-full outline' />
            <span className='text-lg'>{user.displayName}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className='min-w-48 bg-gradient-to-br from-zinc-800'>
          <DropdownMenuLabel>VRChat Account</DropdownMenuLabel>
          <DropdownMenuSeparator className='bg-zinc-700'/>
          <DropdownMenuItem onClick={logout}><LogOut className='h-4 mr-1' /><span className=''>Log out</span></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>;
  }

  return <>
    <Button variant='outline' onClick={() => openLogin()} className='flex items-start'>
      <span className='mt-0.5'>Login to</span><img src={vrchatLogo} className="w-16 ml-2" />
    </Button>
  </>;
}


function App() {
  const [metadata, setMetadata] = useState(null);
  const [unpackPath, setUnpackPath] = useState(null);
  const [transition, setTransition] = useState(false);

  // workaround white flashing background on launch
  useEffect(() => {
    setTimeout(() => appWindow.show(), 100);
  }, []);

  // called when avatar upload finish, clean up unpacked avatar bundle
  const handleFinish = async () => {
    setTransition(true);
    removeDir(unpackPath, {
      recursive: true
    });
    setTimeout(() => {
      setMetadata(null);
      setUnpackPath(null);
      setTransition(false);
    }, 300);

  };

  const handleBundle = (metadata, unpackPath) => {
    setTransition(true);
    setTimeout(() => {
      setMetadata(metadata);
      setUnpackPath(unpackPath);
      setTransition(false);
    }, 300);

  };

  // TODO: upload cancel confirmation prompt
  useEffect(() => {
    let unlisten;
    appWindow.onCloseRequested((event) => {
      if (unpackPath) {
        removeDir(unpackPath, { recursive: true });
      }
    }).then((fn) => unlisten = fn);

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  return (
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <AuthProvider>
        <header className='flex w-full p-4 h-[72px] justify-between items-start'>
          <div onClick={() => open("https://third3d.com")} className='flex items-end transition hover:cursor-pointer hover:drop-shadow-[0_6px_3px_rgba(255,255,255,0.25)]'>
            <img src={thirdLogo} className="h-12 ml-4" alt="Third Logo" />
            <span className='font-bold ml-2 mb-1 text-xl'>Uploader</span>
          </div>
          <User />
        </header>
        <main className='mx-16'>
          <div className={`transition-opacity duration-300 ${transition ? 'opacity-0' : 'opacity-100'}`}>
            {metadata ?
              <Avatar metadata={metadata} onFinish={handleFinish} />
              : <>
                <h1 className='my-8 text-2xl font-semibold flex'>
                  <span className='mt-1'>Upload an Avatar to </span>
                  <img src={vrchatLogo} className="w-32 ml-2 inline" />
                </h1>
                <AssetBundleInput
                  onChange={handleBundle}
                  onError={(msg) => console.error(msg)} />
              </>
            }
          </div>
        </main>
        <Toaster toastOptions={{
          className: "bg-gradient-to-br from-zinc-800 to-zinc-950",
          style: {
            width: "250px",
            right: "0px"
          }
        }} />
        <div className='absolute w-screen h-screen top-0 left-0 -z-20 bg-gradient-to-br from-zinc-800 to-black bg-white' />
      </AuthProvider>
    </ThemeProvider>
  );
}


export default App;