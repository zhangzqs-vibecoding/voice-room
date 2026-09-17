export const AVATARS = [
  { id: 'fox', icon: '🦊', label: '狐狸' }, { id: 'cat', icon: '🐈', label: '猫咪' },
  { id: 'otter', icon: '🦦', label: '水獭' }, { id: 'owl', icon: '🦉', label: '猫头鹰' },
  { id: 'panda', icon: '🐼', label: '熊猫' }, { id: 'rabbit', icon: '🐇', label: '兔子' }
] as const;
export type AvatarId = typeof AVATARS[number]['id'];
export type AudioMode = 'voice' | 'instrument';
export interface Preferences { nickname: string; avatarId: AvatarId; deviceId: string; mode: AudioMode }
const key = 'voice-room.preferences';
export const validateNickname = (value: string): string | null => { const name = value.trim(); return Array.from(name).length >= 1 && Array.from(name).length <= 32 ? name : null; };
export const loadPreferences = (): Preferences => {
  try { const input = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Preferences>; return { nickname: validateNickname(input.nickname ?? '') ?? '', avatarId: AVATARS.some(({ id }) => id === input.avatarId) ? input.avatarId as AvatarId : 'fox', deviceId: typeof input.deviceId === 'string' ? input.deviceId : '', mode: input.mode === 'instrument' ? 'instrument' : 'voice' }; } catch { return { nickname: '', avatarId: 'fox', deviceId: '', mode: 'voice' }; }
};
export const savePreferences = (value: Preferences): void => localStorage.setItem(key, JSON.stringify(value));
