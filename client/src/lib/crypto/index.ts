export {
  createIdentity,
  createIdentityWithBackend,
  detectBackend,
  signPayload,
  verifyPayload,
  type DeviceIdentity,
  type IdentityBackend,
  type StoredIdentity,
} from "./keys.ts";
export {
  DecryptionError,
  decryptMessage,
  encryptMessage,
  type DecryptableMessage,
  type DeviceKeyEnvelope,
  type EncryptedPayload,
  type RecipientDevice,
} from "./envelope.ts";
export { toBase64, fromBase64 } from "./encoding.ts";
export {
  BackupError,
  exportKeyBackup,
  importKeyBackup,
  type BackupFailure,
  type KeyBackupBlob,
} from "./backup.ts";
