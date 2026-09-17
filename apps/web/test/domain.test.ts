import { describe, expect, it } from 'vitest';
import { AVATARS, loadPreferences, validateNickname } from '../src/domain.js';

describe('入场身份', () => {
  it('接受修剪后的昵称和六个预置头像', () => {
    expect(validateNickname('  小林  ')).toBe('小林');
    expect(AVATARS).toHaveLength(6);
  });

  it('拒绝空昵称和超过 32 个字符的昵称', () => {
    expect(validateNickname('   ')).toBeNull();
    expect(validateNickname('a'.repeat(33))).toBeNull();
  });
});

describe('本地偏好', () => {
  it('读取已保存的身份、设备与音频模式', () => {
    localStorage.setItem('voice-room.preferences', JSON.stringify({ nickname: '阿北', avatarId: 'owl', deviceId: 'usb', mode: 'instrument' }));
    expect(loadPreferences()).toEqual({ nickname: '阿北', avatarId: 'owl', deviceId: 'usb', mode: 'instrument' });
  });
});
