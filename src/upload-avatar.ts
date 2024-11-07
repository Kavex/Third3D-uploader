import { createAvatar, createFile, createFileVersion, finishFileUpload, getAvatar, showFile, startFileUpload, updateAvatar, VRChatError, VRChatMimeType } from "./api";
import { metadata } from "tauri-plugin-fs-extra-api";
import { extname, dirname, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api";
import upload from "./upload";
import { Metadata } from "./bundle-input";

const md5DigestFile = (path: string) => invoke('md5_digest_file', { path }) as Promise<string>;
const signatureGenerateFromFile = (path: string, output: string, fake?: boolean) => invoke('signature_generate_from_file', { path, output }) as Promise<void>;
const transcodeBundle = (path: string, output: string) => invoke("transcode_bundle", { path, output }) as Promise<void>;

// returns asssetUrl
async function uploadFileToVRChat(authToken: string, name: string, path: string, mimeType: VRChatMimeType) {
    const extension = "." + await extname(path);
    let file = await createFile(authToken, { name, mimeType, extension });

    const fileMd5 = await md5DigestFile(path);
    const fileMetadata = await metadata(path);

    const signaturePath = path + '.sig';
    await signatureGenerateFromFile(path, signaturePath);
    const signatureMd5 = await md5DigestFile(signaturePath);
    const signatureMetadata = await metadata(signaturePath);

    file = await createFileVersion(authToken, file.id, {
        signatureMd5,
        signatureSizeInBytes: signatureMetadata.size,
        fileMd5,
        fileSizeInBytes: fileMetadata.size
    });

    const uploadFile = async () => {
        if (file.versions[file.versions.length - 1].file.category === "multipart") {
            const partSize = 25 * 1024 * 1024;
            const maxParts = Math.ceil(fileMetadata.size / partSize);
            const etags = Array(maxParts);
            const partUploads = [];
            for (let partNumber = 1; partNumber <= maxParts; partNumber++) {
                const uploadPart = async () => {
                    const start = (partNumber - 1) * partSize;
                    const end = Math.min(partNumber * partSize, fileMetadata.size);
                    const length = end - start;
                    const { url } = await startFileUpload(authToken, file.id, 1, "file", partNumber);
                    const etag = await invoke("upload_file", { url, path, start, length }) as string;
                    if (etag) {
                        etags[partNumber - 1] = etag.replace(/^['"]|['"]$/g, '');
                    } else {
                        console.warn("no etag received");
                    }
                };
                partUploads.push(uploadPart());
            }
            await Promise.all(partUploads);
            await finishFileUpload(authToken, file.id, 1, "file", { etags });
        } else {
            const { url } = await startFileUpload(authToken, file.id, 1, "file");
            const resp = await upload(url, path, null, new Map<string, string>([
                ["Content-Type", mimeType],
                ["Content-MD5", fileMd5]
            ]));
            await finishFileUpload(authToken, file.id, 1, "file");
        }
    };

    const uploadSig = async () => {
        const { url } = await startFileUpload(authToken, file.id, 1, "signature");
        const resp = await upload(url, signaturePath, null, new Map<string, string>([
            ["Content-Type", "application/x-rsync-signature"],
            ["Content-MD5", signatureMd5]
        ]));
        await finishFileUpload(authToken, file.id, 1, "signature");
    };

    await Promise.all([uploadFile(), uploadSig()]);

    const fileUploaded = await showFile(authToken, file.id);
    return fileUploaded.versions[fileUploaded.versions.length - 1].file.url;
}

const avatarFileName = (name: string) => `Avatar - ${name} - Asset bundle - 2022.3.6f1_1_standalonewindows_Release`;
const imageFileName = (name: string) => `Avatar - ${name} - Image - 2022.3.6f1_1_standalonewindows_Release`;

export async function uploadAvatar(authToken: string, metadata: Metadata) {
    let avatar;
    let update = false;
    // try and get avatar, if avatar exists for user, we have to update
    // TODO: prompt user to confirm upload (overwrite)
    try {
        avatar = await getAvatar(authToken, metadata.blueprintId);
        update = true;
    } catch (err) {
        update = false;
    }

    const imageUrl = await uploadFileToVRChat(authToken, imageFileName(metadata.name), metadata.thumbnail, "image/png");
    if (update) {
        await updateAvatar(authToken, avatar.id, { imageUrl });
    } else {
        try {
            avatar = await createAvatar(authToken, { id: metadata.blueprintId, name: metadata.name, imageUrl, releaseStatus: "private", unityVersion: "2022.3.6f1" });
        } catch (err) {
            if (err instanceof VRChatError &&
                err.data.error.status_code === 500
            ) {
                throw new Error("Blueprint ID already in use");
            }
            throw err;
        }
    }

    const bundleUploads = [];
    for (const [platform, bundle] of Object.entries(metadata.assetBundles)) {
        let bundlePath;
        if (await extname(bundle.path) === "vrcaz") {
            const dir = await dirname(bundle.path);
            const out = await join(dir, `${platform}.vrca`);
            await transcodeBundle(bundle.path, out);
            console.log("transcoded");
            bundlePath = out;
        } else {
            bundlePath = bundle.path;
        }

        const uploadBundle = async () => {
            const unityPlatform = platform === "windows" ? "standalonewindows" : platform;
            const avatarUrl = await uploadFileToVRChat(authToken, avatarFileName(metadata.name), bundlePath, "application/x-avatar");
            await updateAvatar(authToken, avatar.id, { assetUrl: avatarUrl, platform: unityPlatform, unityVersion: bundle.unityVersion, assetVersion: 1 });
        };
        bundleUploads.push(uploadBundle());
    }
    await Promise.all(bundleUploads);
}