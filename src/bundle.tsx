import { invoke } from "@tauri-apps/api";
import { exists, readTextFile, removeDir } from "@tauri-apps/api/fs";
import { dirname, join } from "@tauri-apps/api/path";
import { useEffect, useReducer } from "react";
import { z } from "zod";

type Platform = "windows" | "android" | "ios";

const PLATFORMS: [Platform, Platform, Platform] = ["windows", "android", "ios"];

export interface Bundle {
    metadata: Metadata,
    unpackPath: string,
    thumbnailPath: string,
    assetBundlePaths: Partial<Record<Platform, AssetBundlePath>>,
}

interface BundleState {
    bundle: Bundle | null,
    bundlePath: string | null;
    transcodes: Partial<Record<Platform, Promise<string>>>,
    error: any | null;
}

type Action = LoadBundleAction | SetBundleAction | SetTranscodesAction | UnloadBundleAction | SetErrorAction;

interface LoadBundleAction {
    type: "load_bundle",
    bundlePath: string;
}

interface SetBundleAction {
    type: "set_bundle",
    bundle: Bundle;
}

interface SetTranscodesAction {
    type: "set_transcodes",
    transcodes: Partial<Record<Platform, Promise<string>>>;
}

interface UnloadBundleAction {
    type: "unload_bundle",
}

interface SetErrorAction {
    type: "set_error",
    error: any;
}

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

type AssetBundlePath = {
    z: boolean,
    path: string;
};

const reducer = (state: BundleState, action: Action): BundleState => {
    if (action.type === "load_bundle") {
        return { bundle: null, bundlePath: action.bundlePath, transcodes: {}, error: null };
    } else if (action.type === "set_bundle") {
        return { ...state, bundle: action.bundle };
    } else if (action.type === "set_transcodes") {
        return { ...state, transcodes: action.transcodes };
    } else if (action.type === "unload_bundle") {
        if (state.bundle?.unpackPath) removeDir(state.bundle.unpackPath, { recursive: true });
        return { bundle: null, bundlePath: null, transcodes: {}, error: null };
    } else if (action.type === "set_error") {
        return { ...state, error: action.error };
    }
    throw new Error("Invalid action");
};

async function startTranscodes(assetBundlePaths: Partial<Record<Platform, AssetBundlePath>>) {
    const transcodes: Partial<Record<Platform, Promise<string>>> = {};
    for (const [platform, bundlePath] of Object.entries(assetBundlePaths)) {
        if (bundlePath.z) {
            const dir = await dirname(bundlePath.path);
            const outPath = await join(dir, `${platform}.vrca`);
            transcodes[platform as Platform] = transcodeBundle(bundlePath.path, outPath).then(() => outPath);
        }
    }
    return transcodes;
}

export type ReadyBundles = () => AsyncGenerator<{ platform: string, path: string; }>;

export function useBundle() {
    const [state, dispatch] = useReducer(reducer, { bundle: null, bundlePath: null, transcodes: {}, error: null });

    useEffect(() => {
        if (!state.bundlePath) return;
        if (state.bundle) return;
        unpack(state.bundlePath)
            .then(bundle => {
                dispatch({ type: "set_bundle", bundle });
                return startTranscodes(bundle.assetBundlePaths);
            })
            .then(transcodes => dispatch({ type: "set_transcodes", transcodes }))
            .catch((err) => {
                console.error(err);
                dispatch({ type: "set_error", error: err });
            });
    }, [state.bundlePath]);

    async function* readyBundle() {
        if (!state.bundle) throw new Error("No bundle");

        // Start with non Z bundles
        for (const [platform, path] of Object.entries(state.bundle.assetBundlePaths)) {
            if (path.z) continue; // Skip Z
            yield { platform, path: path.path };
        }

        // Create a Map to track pending promises with their indices
        const pending = new Map<number, [string, Promise<string>]>(
            Object.entries(state.transcodes).map(([platform, promise], index) => [index, [platform, promise]])
        );

        // Continue while we have pending promises
        while (pending.size > 0) {
            // Create a map of promise wrappers that include index information
            const wrappedPromises = Array.from(pending.entries()).map(
                ([index, [platform, promise]]) =>
                    promise
                        .then(value => ({ status: 'fulfilled' as 'fulfilled', value, index, platform }))
                        .catch(error => ({ status: 'rejected' as 'rejected', error, index, platform }))
            );

            // Wait for the next promise to complete
            const result = await Promise.race(wrappedPromises);

            // Remove the completed promise from our pending map
            pending.delete(result.index);

            // If the promise was rejected, throw the error
            if (result.status === 'rejected') {
                throw result.error as Error;
            }

            // Yield the resolved value
            yield { platform: result.platform, path: result.value };
        }
    }

    const loading = state.bundlePath !== null && state.bundle === null;

    return { bundle: state.bundle, loading, error: state.error, readyBundle, dispatch };
}


const getMetadataPath = async (unpackPath: string) => await join(unpackPath, "metadata.json");
const getThumbnailPath = async (unpackPath: string) => await join(unpackPath, "thumbnail.png");
const getBundlePath = async (unpackPath: string, platform: Platform, z?: boolean) => await join(unpackPath, `${platform}.${z ? "vrcaz" : "vrca"}`);
const unpackBundle = async (bundlePath: string) => await invoke("unpack_bundle", { path: bundlePath }) as string;
const transcodeBundle = async (assetBundlePath: string, outputPath: string) => invoke<void>("transcode_bundle", { path: assetBundlePath, output: outputPath });


async function unpack(bundlePath: string): Promise<Bundle> {
    const unpackPath = await unpackBundle(bundlePath);
    const metadataPath = await getMetadataPath(unpackPath);
    const thumbnailPath = await getThumbnailPath(unpackPath);
    if (!await exists(metadataPath)) throw new Error("No metadata in avatar bundle");
    if (!await exists(thumbnailPath)) throw new Error("No thumbnail in avatar bundle");

    const metadataText = await readTextFile(metadataPath);
    const res = MetadataSchema.safeParse(JSON.parse(metadataText));
    if (!res.success) throw new Error("Metadata invalid");
    const metadata = res.data;

    const assetBundlePaths: Partial<Record<Platform, AssetBundlePath>> = {};
    for (const platform of ["windows", "android", "ios"]) {
        if (!(platform in metadata.assetBundles)) continue;
        const zPath = await getBundlePath(unpackPath, platform as Platform, true);
        if (await exists(zPath)) {
            assetBundlePaths[platform as Platform] = { path: zPath, z: true };
            continue;
        }
        const path = await getBundlePath(unpackPath, platform as Platform, false);
        if (await exists(path)) {
            assetBundlePaths[platform as Platform] = { path, z: false };
            continue;
        }
        throw new Error(`No asset bundle found for ${platform}`);
    }
    return { metadata, unpackPath, thumbnailPath, assetBundlePaths };
};