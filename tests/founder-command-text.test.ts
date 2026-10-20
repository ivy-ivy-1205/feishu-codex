import { describe, expect, it } from 'vitest';
import { founderCommandText } from '../src/services/founder-command-text.js';

describe('founder command text', () => {
  it('drops Feishu mention placeholders wherever they appear', () => {
    expect(founderCommandText('@_user_1 查看工作地图')).toBe('查看工作地图');
    expect(founderCommandText('查看工作地图 @_user_1')).toBe('查看工作地图');
    expect(founderCommandText('@_user_1 @_user_2 第13项改为已结束')).toBe('第13项改为已结束');
    expect(founderCommandText('@_all 确认修正 feedbackdraft_64ae5845012205353759b42fec99ad4f')).toBe('确认修正 feedbackdraft_64ae5845012205353759b42fec99ad4f');
  });

  it('keeps line breaks for batch corrections and trims trailing sentence punctuation', () => {
    expect(founderCommandText('@_user_1 #3 暂停\n#10 第一期已发布。')).toBe('#3 暂停\n#10 第一期已发布');
    expect(founderCommandText('暂停第3项。')).toBe('暂停第3项');
    expect(founderCommandText('第13项改为已结束！ ')).toBe('第13项改为已结束');
    expect(founderCommandText('  查看工作地图  ')).toBe('查看工作地图');
  });
});
