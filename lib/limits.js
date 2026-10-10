/** 有界持久化的共同契约。 */
export const MESSAGE_CAP = { maxLines: 5000, maxBytes: 2 * 1024 * 1024 }
export const ROUND_LOG_CAP = { maxLines: 2000, maxBytes: 1024 * 1024 }
export const SENDS_LOG_CAP = { maxLines: 2000, maxBytes: 1024 * 1024 }
export const JUDGE_LOG_CAP = { maxLines: 2000, maxBytes: 1024 * 1024 }
export const SENT_MESSAGES_KEEP = 1000
