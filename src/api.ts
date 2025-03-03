import { fetch as fetchT } from '@tauri-apps/plugin-http';

const API_BASE_URL = 'https://api.vrchat.cloud/api/1';
export const USER_AGENT = 'Third Uploader/0.1.2 third3dcom@gmail.com';

const parseSetCookieHeader = (setCookieHeaders: string[]) => {
    const cookies = {};
    for (const setCookieHeader of setCookieHeaders) {
        setCookieHeader.split(',').forEach((cookie) => {
            const [nameValue] = cookie.split(';');
            const [name, value] = nameValue.split('=').map((s) => s.trim());
            cookies[name] = value;
        });
    }
    return cookies;
};

export class VRChatError extends Error {
    data: any;

    constructor(data: any) {
        super("Data: " + JSON.stringify(data));
        this.data = data;
    }
}

type UserResponse = Login2fa | LoginInvalid | LoginUser;

interface Login2fa {
    type: "2fa",
    type2fa: "emailotp" | "totp";
    authToken: string;
}

interface LoginInvalid {
    type: "invalid";
}

interface LoginUser {
    type: "user",
    user: User;
    authToken?: string;
}

export interface User {
    acceptedTOSVersion: number;
    acceptedPrivacyVersion?: number;
    accountDeletionDate: Date | null;
    accountDeletionLog: Array<{
        message: string;
        deletionScheduled: Date | null;
        dateTime: Date;
    }>;
    activeFriends: string[];
    allowAvatarCopying: boolean;
    badges: Array<{
        assignedAt?: Date;
        badgeDescription: string;
        badgeId: string;
        badgeImageUrl: string;
        badgeName: string;
        hidden?: boolean;
        showcased: boolean;
        updatedAt?: Date;
    }>;
    bio: string;
    bioLinks: string[];
    currentAvatar: string;
    currentAvatarAssetUrl: string;
    currentAvatarImageUrl: string;
    currentAvatarThumbnailImageUrl: string;
    currentAvatarTags: string[];
    date_joined: Date;
    developerType: 'none' | 'trusted' | 'internal' | 'moderator';
    displayName: string;
    emailVerified: boolean;
    fallbackAvatar?: string;
    friendGroupNames: string[];
    friendKey: string;
    friends: string[];
    hasBirthday: boolean;
    hideContentFilterSettings?: boolean;
    userLanguage?: string;
    userLanguageCode?: string;
    hasEmail: boolean;
    hasLoggedInFromClient: boolean;
    hasPendingEmail: boolean;
    homeLocation: string;
    id: string;
    isBoopingEnabled?: boolean;
    isFriend: boolean;
    last_activity?: Date;
    last_login: Date;
    last_mobile: Date | null;
    last_platform: string;
    obfuscatedEmail: string;
    obfuscatedPendingEmail: string;
    oculusId: string;
    googleId?: string;
    googleDetails?: Record<string, unknown>;
    picoId?: string;
    viveId?: string;
    offlineFriends: string[];
    onlineFriends: string[];
    pastDisplayNames: Array<{
        displayName: string;
        updated_at: Date;
    }>;
    presence: {
        avatarThumbnail: string | null;
        currentAvatarTags: string;
        displayName: string;
        groups: string[];
        id: string;
        instance: string | null;
        instanceType: string | null;
        isRejoining: string | null;
        platform: string | null;
        profilePicOverride: string | null;
        status: string | null;
        travelingToInstance: string | null;
        travelingToWorld: string;
        userIcon: string | null;
        world: string;
    };
    profilePicOverride: string;
    profilePicOverrideThumbnail: string;
    pronouns: string;
    queuedInstance: string | null;
    receiveMobileInvitations?: boolean;
    state: 'offline' | 'active' | 'online';
    status: 'active' | 'join me' | 'ask me' | 'busy' | 'offline';
    statusDescription: string;
    statusFirstTime: boolean;
    statusHistory: string[];
    steamDetails: Record<string, unknown>;
    steamId: string;
    tags: string[];
    twoFactorAuthEnabled: boolean;
    twoFactorAuthEnabledDate: Date | null;
    unsubscribe: boolean;
    updated_at?: Date;
    userIcon: string;
}

export async function getUser(
    account?: { username: string, password: string; },
    token?: {
        auth?: string,
        twoFactor: string;
    }): Promise<UserResponse> {
    let cookie = "";
    if (token?.auth) {
        cookie += `auth=${token.auth};`;
    }
    if (token?.twoFactor) {
        cookie += `twoFactorAuth=${token.twoFactor};`;
    }
    const auth = account ? 'Basic ' + btoa(encodeURIComponent(account.username) + ':' + encodeURIComponent(account.password)) : undefined;

    const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        'Cookie': cookie
    };

    if (auth) {
        headers['Authorization'] = auth;
    }

    const resp = await fetchT(`${API_BASE_URL}/auth/user`, {
        method: 'GET',
        headers
    });
    const data = await resp.json();

    if (resp.status === 401) {
        console.error(data);
        return { type: "invalid" };
    }

    if (!resp.ok) throw new VRChatError(data);

    let authToken = undefined;
    // Tauri v2 returns headers as a Headers object
    const setCookieHeaders = resp.headers.getSetCookie();
    if (setCookieHeaders && setCookieHeaders.length > 0) {
        const cookies = parseSetCookieHeader(setCookieHeaders);
        authToken = cookies.auth;
    }


    // two factor auth needed
    if (data.requiresTwoFactorAuth) {
        if (data.requiresTwoFactorAuth.includes("emailOtp")) {
            return { type: "2fa", type2fa: "emailotp", authToken };
        } else {
            return { type: "2fa", type2fa: "totp", authToken };
        }
    }

    return { type: "user", user: data as User, authToken };
}

export const verifyTwoFactor = async (args: { authToken: string, type: "emailotp" | "otp" | "totp", code: string; }) => {
    const resp = await fetchT(`${API_BASE_URL}/auth/twofactorauth/${args.type}/verify`, {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${args.authToken}`
        },
        body: JSON.stringify({ code: args.code })
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    const setCookieHeaders = resp.headers.getSetCookie();
    if (setCookieHeaders && setCookieHeaders.length > 0) {
        const cookies = parseSetCookieHeader(setCookieHeaders);
        return cookies.twoFactorAuth as string;
    }
    return null;
};

export const verifyAuthToken = async (token: { auth: string, twoFactor: string; }) => {
    const resp = await fetchT(`${API_BASE_URL}/auth`, {
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${token.auth};twoFactorAuth=${token.twoFactor}`
        }
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};

export const logout = async (authToken: string) => {
    const resp = await fetchT(`${API_BASE_URL}/logout`, {
        method: 'PUT',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${authToken}`
        }
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }
};

interface FileData {
    category: 'multipart' | 'queued' | 'simple';
    fileName: string;
    md5?: string;
    sizeInBytes: number;
    status: 'waiting' | 'complete' | 'none' | 'queued';
    uploadId?: string;
    url: string;
}

interface FileVersion {
    created_at: string;
    deleted?: boolean;
    delta?: FileData;
    file?: FileData;
    signature?: FileData;
    status: 'waiting' | 'complete' | 'none' | 'queued';
    version: number;
}

export type VRChatMimeType = 'image/jpeg' | 'image/jpg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/bmp' | 'image/svg+xml' | 'image/tiff' | 'application/x-avatar' | 'application/x-world' | 'application/gzip' | 'application/x-rsync-signature' | 'application/x-rsync-delta' | 'application/octet-stream';

interface File {
    extension: string;
    id: string;
    mimeType: VRChatMimeType;
    name: string;
    ownerId: string;
    tags: string[];
    versions: FileVersion[];
}

export const createFile = async (authToken: string, fileData: {
    name: string;
    mimeType: string;
    extension: string;
    tags?: string[];
}): Promise<File> => {
    const resp = await fetchT(`${API_BASE_URL}/file`, {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${authToken}`
        },
        body: JSON.stringify(fileData)
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};

export const createFileVersion = async (
    authToken: string,
    fileId: string,
    versionData: {
        signatureMd5: string;
        signatureSizeInBytes: number;
        fileMd5: string;
        fileSizeInBytes: number;
    }
): Promise<File> => {
    try {
        const response = await fetchT(`${API_BASE_URL}/file/${fileId}`, {
            method: 'POST',
            headers: {
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/json',
                'Cookie': `auth=${authToken}`
            },
            body: JSON.stringify(versionData)
        });

        if (response.ok) {
            return await response.json();
        } else {
            const data = await response.json();
            throw new VRChatError(data);
        }
    } catch (error) {
        throw error;
    }
};

export interface Avatar {
    assetUrl: string;
    assetUrlObject?: object;
    authorId: string;
    authorName: string;
    created_at: string;
    description: string;
    featured: boolean;
    id: string;
    imageUrl: string;
    name: string;
    releaseStatus: string;
    tags: string[];
    thumbnailImageUrl: string;
    unityPackageUrl: string;
    unityPackages: {
        assetUrl: string;
        assetUrlObject?: object;
        assetVersion: number;
        created_at: string;
        id: string;
        platform: string;
        pluginUrl: string;
        pluginUrlObject?: object;
        unitySortNumber: number;
        unityVersion: string;
    }[];
    updated_at: string;
    version: number;
}

export const getAvatar = async (authToken: string, avatarId: string): Promise<Avatar> => {
    const resp = await fetchT(`${API_BASE_URL}/avatars/${avatarId}`, {
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${authToken};`
        }
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};

export const createAvatar = async (authToken: string, avatarData: {
    name: string;
    imageUrl?: string;
    assetUrl?: string;
    id?: string;
    description?: string;
    tags?: string[];
    releaseStatus?: 'public' | 'private' | 'hidden' | 'all';
    version?: number;
    unityPackageUrl?: string;
    unityVersion?: string;
}): Promise<Avatar> => {
    const resp = await fetchT(`${API_BASE_URL}/avatars`, {
        method: 'POST',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${authToken};`
        },
        body: JSON.stringify(avatarData)
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};

export const updateAvatar = async (
    authToken: string,
    avatarId: string,
    avatarData: {
        assetUrl?: string;
        name?: string;
        description?: string;
        tags?: string[];
        imageUrl?: string;
        releaseStatus?: string;
        platform?: string;
        unityVersion?: string;
        unityPackageUrl?: string;
        assetVersion?: 1;
    }
): Promise<Avatar> => {
    const resp = await fetchT(`${API_BASE_URL}/avatars/${avatarId}`, {
        method: 'PUT',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${authToken}`
        },
        body: JSON.stringify(avatarData)
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};

export const startFileUpload = async (
    authToken: string,
    fileId: string,
    versionId: number,
    fileType: 'file' | 'signature' | 'delta',
    partNumber?: number
): Promise<{ url: string; }> => {
    const queryParams = new URLSearchParams();
    if (partNumber !== undefined) {
        queryParams.append('partNumber', partNumber.toString());
    }

    const resp = await fetchT(`${API_BASE_URL}/file/${fileId}/${versionId}/${fileType}/start?${queryParams.toString()}`, {
        method: 'PUT',
        headers: {
            'User-Agent': USER_AGENT,
            'Cookie': `auth=${authToken}`
        }
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};

export const finishFileUpload = async (
    authToken: string,
    fileId: string,
    versionId: number,
    fileType: 'file' | 'signature' | 'delta',
    etagData?: { etags: string[]; }
): Promise<File> => {
    const resp = await fetchT(`${API_BASE_URL}/file/${fileId}/${versionId}/${fileType}/finish`, {
        method: 'PUT',
        headers: {
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Cookie': `auth=${authToken}`
        },
        body: etagData ? JSON.stringify(etagData) : undefined
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};

export const showFile = async (authToken: string, fileId: string): Promise<File> => {
    const resp = await fetchT(`${API_BASE_URL}/file/${fileId}`, {
        method: 'GET',
        headers: {
            'User-Agent': USER_AGENT,
            'Cookie': `auth=${authToken}`
        }
    });

    if (!resp.ok) {
        const data = await resp.json();
        throw new VRChatError(data);
    }

    return await resp.json();
};