declare module "@heygen/streaming-avatar" {
  interface StartAvatarRequest {
    /** "relay" | "all" */
    iceTransportPolicy?: string;
    /** TURN url */
    turnServer?: string;
    /** отключить видео */
    video?: boolean;
  }
}
