import { useEffect, useState } from 'react';
import { ThemeProvider } from './components/theme-provider';
import thirdLogo from "./assets/third-logo.svg";
import { Button } from './components/ui/button';
import vrchatLogo from "./assets/VRC_Logo.svg";
import { FileInput } from "./file-input";
import Android from "./assets/android.svg?react";
import Windows from "./assets/windows.svg?react";
import Apple from "./assets/apple.svg?react";
import excellent from './assets/excellent.png';
import good from './assets/good.png';
import medium from './assets/medium.png';
import poor from './assets/poor.png';
import veryPoor from './assets/very-poor.png';
import { ChevronsUpDown, CrossIcon, LogOut, MinusIcon, Upload, XIcon } from 'lucide-react';
import { AuthProvider, useAuth } from './auth';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { TooltipProvider, Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useUpload } from './upload-avatar';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Toaster } from './components/ui/sonner';
import { toast } from 'sonner';
import { open } from '@tauri-apps/plugin-shell';
import { Bundle, useBundle, ReadyBundles } from './bundle';
import { UnlistenFn } from '@tauri-apps/api/event';
import * as api from './api';
const appWindow = getCurrentWebviewWindow();


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


function Avatar(props: { bundle: Bundle, readyBundle: ReadyBundles, onFinish: () => void; }) {
    const { user, authToken, openLogin } = useAuth();
    const { progress, uploading, upload } = useUpload(props.bundle, props.readyBundle);
    const [toastId, setToastId] = useState<string | number | null>(null);
    const bundles = props.bundle.metadata.assetBundles;
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

    useEffect(() => {
        if (!authToken) return;
        const call = async () => {
            try {
                const avatar = await api.getAvatar(authToken, props.bundle.metadata.blueprintId);
                const uploadDates = await Promise.all(
                    avatar.unityPackages
                        .filter(up => up.variant === "standard")
                        .map(async (up) => {
                            const fileUrl = api.parseFileUrl(up.assetUrl);
                            const file = await api.showFile(authToken, fileUrl.id);
                            return new Date(file.versions[file.versions.length - 1].created_at).getTime();
                        })
                );
                const newest = new Date(Math.max(...uploadDates));
                setLastUpdate(newest);
            } catch (err) {
                console.warn(err);
            }
        };
        call();
    }, [authToken]);

    useEffect(() => {
        if (!progress) return;
        if (!toastId) {
            const id = toast.loading("Avatar Upload", { description: "Initiating upload...", duration: Infinity });
            setToastId(id);
            return;
        }

        if (progress.type === "completed") {
            toast.success("Avatar Upload Completed", { id: toastId, description: props.bundle.metadata.name, closeButton: true, duration: Infinity });
            setToastId(null);
            return;
        } else if (progress.type === "error") {
            toast.error("Avatar Upload Failed", { id: toastId, description: progress.msg, closeButton: true, duration: Infinity });
            setToastId(null);
            return;
        }

        let msg: string = "";
        // if (progress.type === "init") msg = "Initiating upload...";
        if (progress.type === 'thumbnail') msg = "Uploading thumbnail...";
        else if (progress.type === "waiting") msg = "Compressing asset bundles...";
        else if (progress.type === "bundle") msg = `Uploading asset bundles: ${progress.platformIndex + 1}/${progress.totalPlatforms}`;
        toast.loading("Avatar Upload", { id: toastId, description: msg, duration: Infinity });

    }, [progress]);

    let progressValue = 0;
    if (progress?.type === "init") progressValue = 5;
    else if (progress?.type === "thumbnail") progressValue = 10;
    else if (progress?.type === "waiting") progressValue = 15;
    else if (progress?.type === "bundle") progressValue = 30 + ((progress.part / progress.totalParts) * ((progress.platformIndex + 1) / progress.totalPlatforms)) * 70;

    const handleUpload = () => {
        const runUpload = async (authToken: string) => {
            await upload(authToken);
            props.onFinish();
        };

        if (authToken && user) {
            runUpload(authToken);
        } else {
            // login handler gets removed, when auth is cancelled. 
            // upload can only be cancelled after auth is cancelled,
            // therefore no need to remove login handler when upload is cancelled
            openLogin(runUpload);
        }
    };

    const handleCancel = () => {
        props.onFinish();
    };


    return <>
        <div className='flex flex-col items-center h-full'>
            <div className='flex flex-col items-center gap-6'>
                <h1 className='text-3xl font-semibold'>{props.bundle.metadata.name}</h1>
                <img src={convertFileSrc(props.bundle.thumbnailPath)} className='aspect-[4/3] w-96 shadow-2xl shadow-black rounded-xl object-cover' />
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
                    <div className='flex flex-col gap-1'>
                        <div className='flex items-center gap-2'>
                            <Button variant='outline' onClick={handleCancel} disabled={uploading}>Cancel</Button>
                            <Button onClick={handleUpload} className='pl-3 transition-shadow hover:shadow-lg hover:shadow-white/50' disabled={uploading}><Upload className="h-4 mr-2" />
                                {lastUpdate ? "Update" : "Upload"}
                            </Button>
                        </div>
                        {lastUpdate && <p className='text-sm text-muted-foreground'>Last upload: {lastUpdate.toLocaleString()}</p>}
                    </div>
                </TooltipProvider>
            </div>
            <div className='grow' />
            <div className='w-full'>
                <div style={{ width: `${progressValue}%` }} className={`h-4 bg-white transition-all shadow-[-5px_-5px_15px_0px_rgba(255,255,255,0.4)]`} />
            </div>
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
                    <Button variant='ghost' className='flex gap-2 hover:bg-white/10 rounded-none focus-visible:ring-0' >
                        {/* <img src={imgUrl} className='size-12 object-cover rounded-full outline' /> */}
                        <span className='text-md font-medium'>{user.displayName}</span>
                        <ChevronsUpDown className='size-4' />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className='min-w-48 bg-gradient-to-br from-zinc-800'>
                    <DropdownMenuLabel>VRChat Account</DropdownMenuLabel>
                    <DropdownMenuSeparator className='bg-zinc-700' />
                    <DropdownMenuItem onClick={logout}><LogOut className='h-4 mr-1' /><span className=''>Log out</span></DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </>;
    }

    return <>
        <Button variant='outline' onClick={() => openLogin()} className='flex items-start rounded-none'>
            <span className='mt-0.5'>Login to</span><img src={vrchatLogo} className="w-16 ml-2" />
        </Button>
    </>;
}


function App() {
    const { bundle, loading, error, readyBundle, dispatch } = useBundle();
    const [showBundle, setShowBundle] = useState(false);
    const [transition, setTransition] = useState(false);

    // workaround white flashing background on launch
    useEffect(() => {
        const call = async () => {
            const file = await invoke("file_arg");
            console.log(file);
            if (file) handleFile(file as string);
        };
        call();
    }, []);

    // TODO: upload cancel confirmation prompt
    useEffect(() => {
        let unlisten: UnlistenFn;
        appWindow.onCloseRequested((event) => {
            if (bundle) dispatch({ type: "unload_bundle" });
        }).then((fn) => unlisten = fn);
        return () => {
            if (unlisten) {
                unlisten();
            }
        };
    }, []);

    useEffect(() => {
        if (bundle) {
            setTransition(true);
            setTimeout(() => {
                setShowBundle(true);
                setTransition(false);
            }, 300);
        }
    }, [bundle]);

    useEffect(() => {
        if (error) {
            toast.error("Loading Avatar Bundle Failed", { description: error.message });
            dispatch({ type: "unload_bundle" });
        }
    }, [error]);

    // called when avatar upload finish, clean up unpacked avatar bundle
    const handleFinish = async () => {
        setTransition(true);
        setTimeout(() => {
            dispatch({ type: "unload_bundle" });
            setShowBundle(false);
            setTransition(false);
        }, 300);
    };

    const handleFile = (path: string) => dispatch({ type: "load_bundle", bundlePath: path });
    const handleMinimize = () => {
        appWindow.minimize();
    };
    const handleClose = () => {
        appWindow.close();
    };

    return (
        <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
            <AuthProvider>
                <div className='h-screen flex flex-col'>
                    <header className='flex w-full h-[72px] justify-between items-start'>
                        <div data-tauri-drag-region className='flex justify-between grow'>
                            <div onClick={() => open("https://third3d.com")} className='flex p-2 items-end transition hover:cursor-pointer hover:drop-shadow-[0_6px_3px_rgba(255,255,255,0.25)]'>
                                <img src={thirdLogo} className="h-12 ml-4" alt="Third Logo" />
                                <span className='font-bold ml-2 mb-1 text-xl'>Uploader</span>
                            </div>
                            <User />
                        </div>
                        <div className='flex'>
                            <Button variant="ghost" className='rounded-none text-muted-foreground hover:bg-white/10' onClick={handleMinimize}><MinusIcon className='size-5' /></Button>
                            <Button variant="ghost" className='rounded-none text-muted-foreground hover:bg-red-600' onClick={handleClose}><XIcon className='size-5' /></Button>
                        </div>
                    </header>
                    <main className={`h-full transition-opacity duration-300 ${transition ? 'opacity-0' : 'opacity-100'}`}>
                        {showBundle && bundle ?
                            <Avatar bundle={bundle} readyBundle={readyBundle} onFinish={handleFinish} />
                            : <div className='mx-16'>
                                <h1 className='my-8 text-2xl font-semibold flex'>
                                    <span className='mt-1'>Upload an Avatar to </span>
                                    <img src={vrchatLogo} className="w-32 ml-2 inline" />
                                </h1>
                                <FileInput extension='3b' onChange={handleFile} loading={loading} />
                            </div>
                        }
                    </main>
                    <Toaster theme="dark" toastOptions={{
                        className: "bg-gradient-to-br from-zinc-800 to-zinc-950",
                        style: {
                            width: "250px",
                            right: "0px"
                        },
                    }} />
                    {/* <div className='absolute w-screen h-screen top-0 left-0 -z-20 bg-gradient-to-br from-black/20 to-black/90 bg-fixed' /> */}
                </div>
            </AuthProvider>
        </ThemeProvider>
    );
}


export default App;