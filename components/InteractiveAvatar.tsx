// --- InteractiveAvatar.tsx (no global recycle, only soft restarts) ---

import {
  AvatarQuality,
  StreamingEvents,
  VoiceChatTransport,
  VoiceEmotion,
  StartAvatarRequest,
  STTProvider,
  ElevenLabsModel,
  IceTransportPolicy,
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

/* ---------- DEFAULT CONFIG ---------- */
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
  activityIdleTimeout: 900,
  voiceChatTransport: VoiceChatTransport.WEBSOCKET,
  sttSettings: { provider: STTProvider.DEEPGRAM },
};

function InteractiveAvatar() {
  const { initAvatar, startAvatar, stopAvatar, sessionState, stream } =
    useStreamingAvatarSession();
  const { startVoiceChat } = useVoiceChat();

  const [config, setConfig] = useState<StartAvatarRequest>(DEFAULT_CONFIG);
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const isVoiceChatRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const fetchAccessToken = async () => {
    const res = await fetch("/api/get-access-token", { method: "POST" });
    return res.text();
  };

  /* ---------- helper to soft‑restart only media pipeline ---------- */
  const softRestartTracks = useMemoizedFn(async () => {
    if (sessionState !== StreamingAvatarSessionState.CONNECTED) return;
    try {
      await startVoiceChat();
      console.info("🟢 soft restart tracks done");
    } catch (e: any) {
      // HeyGen вернёт 400, если already listening; 401, если токен устарел
      const msg = e?.message || "";
      if (msg.includes("400") || msg.includes("401")) {
        console.warn("soft restart: benign error", msg);
      } else {
        console.error("soft restart failed", e);
      }
    }
  });

  /* ---------- manual session start ---------- */
  const startSession = useMemoizedFn(async (needVoice: boolean) => {
    try {
      const token = await fetchAccessToken();
      const avatar = initAvatar(token);
      avatar.on(StreamingEvents.STREAM_DISCONNECTED, softRestartTracks);

      await startAvatar(configRef.current);
      if (needVoice) {
        await startVoiceChat();
        isVoiceChatRef.current = true;
      }
    } catch (e) {
      console.error("startSession error", e);
    }
  });

  useUnmount(() => stopAvatar());

  /* ---------- bind video ---------- */
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => videoRef.current?.play();
    }
  }, [stream]);

  /* ---------- freeze watchdog ---------- */
  useEffect(() => {
    let prev = 0;
    let freezeCount = 0;
    const SOFT_LIMIT = 3; // после 3 подряд фризов делаем hard‑reset

    const id = setInterval(async () => {
      const v = videoRef.current;
      if (!v) return;

      if (v.currentTime === prev && sessionState === StreamingAvatarSessionState.CONNECTED) {
        console.warn("⚠️ media freeze → soft restart");
        await softRestartTracks();
        freezeCount += 1;

        if (freezeCount >= SOFT_LIMIT) {
          console.warn("⚠️ soft restarts exhausted → HARD reset");
          freezeCount = 0;
          try {
            await stopAvatar();
            await new Promise(r => setTimeout(r, 600));
            const tok = await fetchAccessToken();
            const avatar = initAvatar(tok);
            avatar.on(StreamingEvents.STREAM_DISCONNECTED, softRestartTracks);
            await startAvatar(configRef.current);
            if (isVoiceChatRef.current) await startVoiceChat();
          } catch (e) {
            console.error("hard reset failed", e);
          }
        }
      } else {
        freezeCount = 0; // кадр движется – обнуляем счётчик
      }
      prev = v.currentTime;
    }, 10_000);

    return () => clearInterval(id);
  }, [softRestartTracks, sessionState]);

  /* ---------- JSX ---------- */
  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col rounded-xl bg-zinc-900 overflow-hidden">
        <div className="relative w-full aspect-video flex items-center justify-center">
          {sessionState !== StreamingAvatarSessionState.INACTIVE ? (
            <AvatarVideo ref={videoRef} />
          ) : (
            <AvatarConfig config={config} onConfigChange={setConfig} />
          )}
        </div>
        <div className="flex flex-col items-center gap-3 p-4 border-t border-zinc-700">
          {sessionState === StreamingAvatarSessionState.CONNECTED ? (
            <AvatarControls />
          ) : sessionState === StreamingAvatarSessionState.INACTIVE ? (
            <div className="flex gap-4">
              <Button onClick={() => startSession(true)}>Start Voice Chat</Button>
              <Button onClick={() => startSession(false)}>Start Text Chat</Button>
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

export default function InteractiveAvatarWrapper() {
  return (
    <StreamingAvatarProvider basePath={process.env.NEXT_PUBLIC_BASE_API_URL}>
      <InteractiveAvatar />
    </StreamingAvatarProvider>
  );
}
