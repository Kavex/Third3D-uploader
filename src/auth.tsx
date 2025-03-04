import { createContext, FormEvent, MouseEvent, ReactNode, useContext, useEffect, useState } from "react";
import { getUser, User, verifyTwoFactor, logout as apiLogout } from "./api";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { BaseDirectory, exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Label } from "./components/ui/label";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import vrchatLogo from "./assets/VRC_Logo.svg";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./components/ui/input-otp";
import { Alert, AlertDescription } from "./components/ui/alert";
import { LoaderCircle } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";


const ExternalLink = (props: { href: string, children: ReactNode; }) => {
  const handleClick = async (e: MouseEvent) => {
    e.preventDefault();
    try {
      await open(props.href);
    } catch (error) {
      console.error('Failed to open link:', error);
    }
  };

  return (
    <a
      href={props.href}
      onClick={handleClick}
      className="text-blue-600 hover:text-blue-800 underline"
    >
      {props.children}
    </a>
  );
};


interface Token {
  auth: string,
  twoFactor: string;
}

const saveToken = async (username: string, token: Token) => {
  await invoke('save_token', { username, token });
};

const loadToken = async (username: string) => {
  return await invoke('load_token', { username }) as Token;
};

const deleteToken = async (username: string) => {
  return await invoke('delete_token', { username });
};

const ConfigShema = z.object({
  lastUsername: z.string().nullable()
});

const saveConfig = async (config: z.infer<typeof ConfigShema>) => {
  await writeTextFile("config.json", JSON.stringify(config), { baseDir: BaseDirectory.AppData, });
};

const loadConfig = async () => {
  if (!await exists("config.json", { baseDir: BaseDirectory.AppData })) {
    return null;
  }
  const str = await readTextFile("config.json", {
    baseDir: BaseDirectory.AppData
  });
  const config = ConfigShema.parse(JSON.parse(str));
  return config;
};

interface AuthContext {
  user: User | null,
  authToken: string | null,
  openLogin: (onLogin?: (authToken: string) => any) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContext | null>(null);
export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("Component not inside AuthProvider");
  return ctx;
};


export function AuthProvider(props: { children: ReactNode; }) {
  // auth states
  const [user, setUser] = useState<User | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [twoFactorType, setTwoFactorType] = useState<"emailotp" | "totp" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [{ onLogin }, setOnLogin] = useState<{ onLogin: ((authToken: string) => any) | null; }>({ onLogin: null }); // workaround next state updater function argument

  // ui states
  const [loginOpen, setLoginOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // inputs
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  // try to log in with token on launch
  useEffect(() => {
    const load = async () => {
      const config = await loadConfig();
      if (!config?.lastUsername) return;
      setUsername(config.lastUsername);

      const token = await loadToken(config.lastUsername);
      if (!token) return;
      const res = await getUser(undefined, token);
      if (res.type !== "user") return;

      setUser(res.user);
      setAuthToken(token.auth);
    };
    load();
  }, []);

  useEffect(() => {
    // check if logged in and has on login handler
    if (onLogin && user && authToken) {
      onLogin(authToken);
      setOnLogin({ onLogin: null });
    }
  }, [onLogin, user, authToken]);


  const login = async (username: string, password: string) => {
    setLoading(true);
    try {
      const token = await loadToken(username);
      const res = await getUser({ username, password }, token);
      if (res.type === "user") {
        setLoginOpen(false);
        setUser(res.user);
        // logged in with twoFactorAuth, but token invalid? hope it sets new token
        if (res.authToken) {
          console.log("received new token");
          setAuthToken(res.authToken);
          await saveToken(username, { auth: res.authToken, twoFactor: token.twoFactor });
        } else {
          setAuthToken(token.auth);
        }
        await saveConfig({ lastUsername: username });
      } else if (res.type === "2fa") {
        setAuthToken(res.authToken);
        setTwoFactorType(res.type2fa);
      } else if (res.type === "invalid") {
        setError("Invalid username or password");
      }
    } finally {
      setLoading(false);
    }
  };

  const twoFactor = async (code: string) => {
    if (!authToken) throw new Error("No auth token");
    if (!twoFactorType) throw new Error("No two factor type");
    setLoading(true);
    setError(null);
    try {
      const twoFactorToken = await verifyTwoFactor({ authToken, type: twoFactorType, code });
      const token = { auth: authToken, twoFactor: twoFactorToken };
      const resp = await getUser(undefined, token);
      if (resp.type !== "user") { // TODO: Handle failing 2fa better
        throw new Error("Failed to get user after 2FA");
      }
      setUser(resp.user);
      setLoginOpen(false);
      setCode("");
      setTwoFactorType(null);
      await saveToken(username, token);
      await saveConfig({ lastUsername: username });
    } catch (error) {
      console.error("Two-factor authentication failed:", error);
      setError("Two-factor authentication failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setUser(null);
    setAuthToken(null);
    setUsername("");
    setPassword("");
    await saveConfig({ lastUsername: null });
    await deleteToken(username);
    if (authToken) {
      await apiLogout(authToken);
    }
  };

  const openLogin = (onLogin?: (authToken: string) => any) => {
    if (onLogin) {
      setOnLogin({ onLogin });
    }
    setLoginOpen(true);
  };

  const handleLogin = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    setError(null);
    login(username, password);
  };

  const handleLoginChange = (open: boolean) => {
    if (open) {
      setLoginOpen(true);
    } else {
      // cancel two factor auth
      if (twoFactorType) {
        setTwoFactorType(null);
        setCode("");

        // clean up auth token
        if (authToken) {
          setAuthToken(null);
          apiLogout(authToken);
        }
      }
      setOnLogin({ onLogin: null });
      setError(null);
      setLoginOpen(false);
    }
  };

  const handleTwoFactor = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    setError(null);
    twoFactor(code);
  };

  return (
    <AuthContext.Provider value={{ user, authToken, openLogin, logout }}>
      {props.children}
      <Dialog open={loginOpen} onOpenChange={handleLoginChange}>
        <DialogContent className='max-w-sm bg-transparent bg-gradient-to-br from-zinc-700/50 to-black/50 backdrop-blur-lg'>
          <DialogHeader>
            <DialogTitle className='flex items-start'>
              <span className='text-lg font-semibold'>Login to</span><img src={vrchatLogo} className="w-24 ml-2" alt="VRChat" />
            </DialogTitle>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {!twoFactorType ? (
            <>
              <form onSubmit={handleLogin} autoComplete="off" className="flex flex-col flex-grow gap-4">
                <div>
                  <Label htmlFor="username">Username/Email</Label>
                  <Input
                    id="username"
                    placeholder='Username/Email'
                    value={username}
                    onChange={(ev) => setUsername(ev.target.value)}
                    disabled={loading}
                  />
                </div>
                <div>
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    placeholder='Password'
                    type='password'
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    disabled={loading}
                  />
                </div>

                <Button disabled={loading}>
                  <span className="relative flex items-center">
                    {loading && <LoaderCircle className="absolute right-full mr-2 animate-spin" />}
                    Login
                  </span>
                </Button>
              </form>
            </>
          ) : (
            <>
              <form onSubmit={handleTwoFactor} autoComplete="off" className="flex flex-col flex-grow gap-4">
                <Label>One-Time Password</Label>
                <InputOTP
                  maxLength={6}
                  value={code}
                  onChange={(c) => setCode(c)}
                  disabled={loading}
                  autoFocus>
                  <InputOTPGroup className="mx-auto">
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                    <InputOTPSlot index={3} />
                    <InputOTPSlot index={4} />
                    <InputOTPSlot index={5} />
                  </InputOTPGroup>
                </InputOTP>
                <Button disabled={loading}>
                  <span className="relative flex items-center">
                    {loading && <LoaderCircle className="absolute right-full mr-2 animate-spin" />}
                    Verify
                  </span>
                </Button>
              </form>
            </>
          )}
          <DialogFooter className='text-sm text-zinc-400'>
            <div>
              <p>Third Uploader communicates directly with the VRChat servers.</p>
              <p>Third Uploader is open source and can be found here: <ExternalLink href={"https://github.com/third3d/uploader"}>github.com/third3d/uploader</ExternalLink></p>
              <br />
              <p className='text-xs'>Third Uploader is not affiliated with, endorsed, sponsored, or specifically approved by VRChat Inc.</p>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthContext.Provider>);
};
