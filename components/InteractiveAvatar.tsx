import {
  AvatarQuality,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
  StartAvatarRequest,
  STTProvider,
  ElevenLabsModel,
} from "@heygen/streaming-avatar";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn, useUnmount } from "ahooks";

import { Button } from "./Button";
import { AvatarConfig } from "./AvatarConfig";
import { AvatarVideo } from "./AvatarSession/AvatarVideo";
import { useStreamingAvatarSession } from "./logic/useStreamingAvatarSession";
import { AvatarControls } from "./AvatarSession/AvatarControls";
import { useVoiceChat } from "./logic/useVoiceChat";
import { StreamingAvatarProvider, StreamingAvatarSessionState } from "./logic";
import { LoadingIcon } from "./Icons";
import { MessageHistory } from "./AvatarSession/MessageHistory";

import { AVATARS } from "@/app/lib/constants";

/* ---------------- DEFAULT CONFIG ---------------- */
const DEFAULT_CONFIG: StartAvatarRequest = {
  quality: AvatarQuality.Low,
  avatarName: AVATARS[0].avatar_id,
  knowledgeId: undefined,
  voice: {
    rate: 1.5,
    emotion: VoiceEmotion.EXCITED,
    model: ElevenLabsModel.eleven_flash_v2_5,
  },
  language: "en",
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: {
    provider: STTProvider.DEEPGRAM,
  },
};

function InteractiveAvatar() {
  /* ---------- hooks from SDK wrappers ---------- */
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  /* ---------- CONFIG STATE ---------- */
  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);

  // свежий config вне замыканий
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  /* ---------- REFS / STATE FOR ROBUSTNESS ---------- */
  const mediaStream = useRef<HTMLVideoElement>(null);
  const avatarRef = useRef<any>(null);
  const keepAliveIntervalRef = useRef<number | null>(null);
  const isVoiceChatRef = useRef<boolean>(false);
  const reconnectRef = useRef<{ attempts: number; timer: number | undefined }>({
    attempts: 0,
    timer: undefined,
  });

  // «здоровая» сессия
  const isHealthy = useMemoizedFn(
    () => sessionState === StreamingAvatarSessionState.CONNECTED
  );

  /* ---------- TOKEN FETCH ---------- */
  async function fetchAccessToken() {
    const response = await fetch("/api/get-access-token", { method: "POST" });
    if (!response.ok) throw new Error("Failed to fetch access token");
    const token = await response.text();
    console.log("Access Token:", token);
    return token;
  }

  /* ---------- SOFT RESTART (перевешиваем треки / STT) ---------- */
  const softRestartTracks = useMemoizedFn(async () => {
    if (!isHealthy()) return;
    try {
      await startVoiceChat();
      console.info("🟢 soft restart tracks done");
    } catch (e: any) {
      console.warn("soft restart warning:", e?.message || e);
    }
  });

  /* ---------- HARD RESET with backoff ---------- */
  const hardResetWithBackoff = useMemoizedFn(async (reason: string) => {
    if (reconnectRef.current.timer) return; // уже запланирован
    const attempt = reconnectRef.current.attempts;
    const delay =
      Math.min(15000, 1000 * Math.pow(2, attempt)) +
      Math.floor(Math.random() * 300);
    reconnectRef.current.attempts = attempt + 1;

    reconnectRef.current.timer = window.setTimeout(async () => {
      reconnectRef.current.timer = undefined;
      try {
        console.warn(`🔁 HARD reset: ${reason}, attempt=${attempt}`);
        await stopAvatar();
        avatarRef.current = null;
        await new Promise((r) => setTimeout(r, 600));

        const token = await fetchAccessToken();
        const newAvatar = initAvatar(token);
        avatarRef.current = newAvatar;
        setupAvatarEventHandlers(newAvatar);

        const extendedConfig: StartAvatarRequest = {
          ...configRef.current,
          activityIdleTimeout: 3600, // максимум 1 час
        };
        await startAvatar(extendedConfig);

        if (isVoiceChatRef.current && isHealthy()) {
          await startVoiceChat();
        }
        reconnectRef.current.attempts = 0; // успех
        console.info("✅ HARD reset done");
      } catch (e) {
        console.error("hard reset failed, will retry", e);
        hardResetWithBackoff("retry after fail");
      }
    }, delay);
  });

  /* ---------- AVATAR EVENT HANDLERS ---------- */
  const setupAvatarEventHandlers = useMemoizedFn((avatar: any) => {
    if (!avatar) return;

    avatar.on(StreamingEvents.AVATAR_START_TALKING, (e: any) => {
      console.log("Avatar started talking", e);
    });
    avatar.on(StreamingEvents.AVATAR_STOP_TALKING, (e: any) => {
      console.log("Avatar stopped talking", e);
    });
    avatar.on(StreamingEvents.STREAM_READY, (event: any) => {
      console.log(">>>>> Stream ready:", event.detail);
    });
    avatar.on(StreamingEvents.USER_START, (event: any) => {
      console.log(">>>>> User started talking:", event);
    });
    avatar.on(StreamingEvents.USER_STOP, (event: any) => {
      console.log(">>>>> User stopped talking:", event);
    });
    avatar.on(StreamingEvents.USER_END_MESSAGE, (event: any) => {
      console.log(">>>>> User end message:", event);
    });
    avatar.on(StreamingEvents.USER_TALKING_MESSAGE, (event: any) => {
      console.log(">>>>> User talking message:", event);
    });
    avatar.on(StreamingEvents.AVATAR_TALKING_MESSAGE, (event: any) => {
      console.log(">>>>> Avatar talking message:", event);
    });
    avatar.on(StreamingEvents.AVATAR_END_MESSAGE, (event: any) => {
      console.log(">>>>> Avatar end message:", event);
    });

    // ключевой обработчик обрыва
    avatar.on(StreamingEvents.STREAM_DISCONNECTED, async () => {
      console.warn("⚠️ STREAM_DISCONNECTED → soft restart & backoff hard reset");
      try {
        await softRestartTracks();
      } finally {
        hardResetWithBackoff("stream disconnected");
      }
    });
  });

  /* ---------- START SESSION (VOICE / TEXT) ---------- */
  const startSessionV2 = useMemoizedFn(async (isVoiceChat: boolean) => {
    try {
      isVoiceChatRef.current = isVoiceChat;

      const newToken = await fetchAccessToken();
      const avatar = initAvatar(newToken);
      avatarRef.current = avatar;

      setupAvatarEventHandlers(avatar);

      const extendedConfig: StartAvatarRequest = {
        ...configRef.current,
        activityIdleTimeout: 3600, // максимум 1 час
      };
      await startAvatar(extendedConfig);

      // keepAlive каждые 5 минут — только в здоровом состоянии
      if (keepAliveIntervalRef.current == null) {
        keepAliveIntervalRef.current = window.setInterval(() => {
          if (isHealthy() && avatarRef.current?.keepAlive) {
            avatarRef.current.keepAlive();
          }
        }, 300000);
      }

      if (isVoiceChat && isHealthy()) {
        await startVoiceChat();
      }
    } catch (error) {
      console.error("Error starting avatar session:", error);
    }
  });

  /* ---------- SILENT PERIODIC RECYCLE (раз в 10 минут) ---------- */
  useEffect(() => {
    const TEN_MIN = 10 * 60 * 1000;
    const id = window.setInterval(async () => {
      if (!navigator.onLine || !avatarRef.current) return;
      try {
        console.info("♻️ Silent recycle started");
        await stopAvatar();
        avatarRef.current = null;
        await new Promise((r) => setTimeout(r, 500));

        const token = await fetchAccessToken();
        const newAvatar = initAvatar(token);
        avatarRef.current = newAvatar;
        setupAvatarEventHandlers(newAvatar);

        await startAvatar({
          ...configRef.current,
          activityIdleTimeout: 3200,
        });

        if (isVoiceChatRef.current && isHealthy()) {
          await startVoiceChat();
        }
        console.info("✅ Silent recycle done");
      } catch (e) {
        console.error("♻️ Recycle failed", e);
        hardResetWithBackoff("recycle failed");
      }
    }, TEN_MIN);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- ONLINE / OFFLINE ---------- */
  useEffect(() => {
    const onOnline = () => hardResetWithBackoff("browser online");
    const onOffline = () => console.warn("⚠️ browser offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [hardResetWithBackoff]);

  /* ---------- CLEANUP ON UNMOUNT ---------- */
  useUnmount(() => {
    if (keepAliveIntervalRef.current != null) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }
    if (reconnectRef.current.timer) {
      clearTimeout(reconnectRef.current.timer);
      reconnectRef.current.timer = undefined;
    }
    reconnectRef.current.attempts = 0;
    avatarRef.current = null;
    stopAvatar();
  });

  /* ---------- ATTACH MEDIA STREAM ---------- */
  useEffect(() => {
    if (stream && mediaStream.current) {
      mediaStream.current.srcObject = stream as any;
      mediaStream.current.onloadedmetadata = () => {
        mediaStream.current!.play();
      };
    }
  }, [stream]);

  /* ---------------- RENDER ---------------- */
  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        {/* Video / Config switch */}
        <div className="relative w-full aspect-video overflow-hidden flex flex-col items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={mediaStream} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        {/* Controls */}
        <div className="flex flex-col gap-3 items-center justify-center p-4 border-t border-zinc-700 w-full">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex flex-row gap-4">
              <Button onClick={() => startSessionV2(true)}>Start Voice Chat</Button>
              <Button onClick={() => startSessionV2(false)}>Start Text Chat</Button>
            </div>
          ) : (
            <LoadingIcon />
          )}
        </div>
      </div>
      {sessionState === StreamingAvatarSessionState.CONNECTED && <MessageHistory />}
    </div>
  );
}

/* ---------- PROVIDER WRAPPER ---------- */
export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
