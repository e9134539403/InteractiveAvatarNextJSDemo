declare module "@heygen/streaming-avatar" {
  /** расширяем только интерфейс — другие экспорты остаются */
  interface StartAvatarRequest {
    iceTransportPolicy?: string;      // "relay" | "all"
    turnServer?: string;              // TURN url
    video?: boolean;                  // опция «только звук»
  }
}

export {};            // ← ОБЯЗАТЕЛЬНО, одна пустая export-строчка
