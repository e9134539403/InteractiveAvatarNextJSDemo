"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import StreamingAvatar, {
  AvatarQuality,
  StreamingEvents,
} from "@heygen/streaming-avatar";

export default function InteractiveAvatar() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sa, setSa] = useState<StreamingAvatar | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const start = useCallback(async () => {
    try {
      setErr(null);
      // 1) берём одноразовый session token с сервера
      const res = await fetch("/api/get-access-token", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
      const { token } = await res.json();

      // 2) создаём клиента SDK по токену (БЕЗ ручных вызовов streaming.new/start)
      const client = new StreamingAvatar({ token });

      // события (по желанию)
      client.on(StreamingEvents.STREAM_READY, async () => {
        const ms = await client.getMediaStream?.();
        if (videoRef.current && ms) {
          // подключаем медиапоток к <video>
          videoRef.current.srcObject = ms as MediaStream;
          await videoRef.current.play().catch(() => {});
        }
      });
      client.on(StreamingEvents.STREAM_DISCONNECTED, () => setRunning(false));

      // 3) стартуем аватара
      await client.createStartAvatar({
        quality: AvatarQuality.Medium,
        // можно задать avatarName / voiceId / background, если нужно:
        // avatarName: "laya",
        // voiceId: "jenny",
      });

      setSa(client);
      setRunning(true);
    } catch (e: any) {
      setErr(e?.message || "Failed to start avatar");
      console.error(e);
    }
  }, []);

  const stop = useCallback(async () => {
    try { await sa?.stopAvatar?.(); } catch {}
    setRunning(false);
  }, [sa]);

  useEffect(() => {
    return () => { sa?.stopAvatar?.().catch(() => {}); };
  }, [sa]);

  return (
    <div className="flex flex-col gap-3">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full aspect-video bg-black rounded"
      />
      <div className="flex gap-2">
        {!running ? (
          <button onClick={start} className="px-4 py-2 rounded bg-black text-white">
            Start Avatar
          </button>
        ) : (
          <button onClick={stop} className="px-4 py-2 rounded bg-gray-200">
            Stop
          </button>
        )}
      </div>
      {err && <div className="text-red-600 text-sm">{err}</div>}
    </div>
  );
}
