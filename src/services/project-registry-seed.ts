import type { ProjectDefinition, ProjectMappingRule } from '../domain/project.js';

export const initialProjectDefinitions = [
  { projectKey: 'feishu-adaptor', displayName: 'FeishuAdaptor', aliases: ['feishu codex', '飞书 codex', 'bridge', 'project 6'], localPathHint: '/Users/mengxi/Projects/FeishuAdaptor', repoUrl: 'https://github.com/ivy-ivy-1205/feishu-codex', defaultBranch: 'main', status: 'active' },
  { projectKey: 'openmontage', displayName: 'OpenMontage', aliases: ['B-roll', 'A-roll', '视频合成', 'timeline', 'Backlot'], localPathHint: '/Users/mengxi/Projects/OpenMontage', repoUrl: null, defaultBranch: null, status: 'active' },
  { projectKey: 'aijia-landingpage', displayName: 'aijia-landingpage', aliases: ['首页', 'landing page', 'Hero', '官网首页'], localPathHint: '/Users/mengxi/Documents/aijia-landingpage', repoUrl: null, defaultBranch: null, status: 'active' },
  { projectKey: 'realagent-ai-cc', displayName: 'RealAgentAI_cc', aliases: ['Amy Live', 'Amy 语音通话', 'Amy Wechat', '买家 Amy', 'SmartListing Amy'], localPathHint: '/Users/mengxi/Desktop/RealAgentAI_cc', repoUrl: null, defaultBranch: null, status: 'active' },
  { projectKey: 'ljhooker-audiobooks', displayName: 'ljhooker-audiobooks', aliases: ['静姐有声书', '有声书', 'audiobook'], localPathHint: '/Users/mengxi/Projects/ljhooker-audiobooks', repoUrl: null, defaultBranch: null, status: 'active' },
  { projectKey: 'ivy-xhs', displayName: 'ivy-xhs', aliases: ['小红书', 'XHS', 'rednote'], localPathHint: '/Users/mengxi/Projects/ivy-xhs', repoUrl: null, defaultBranch: null, status: 'active' },
  { projectKey: 'james-wechat', displayName: 'James公众号', aliases: ['公众号', 'James公众号', 'James 公众号', '微信文章'], localPathHint: '/Users/mengxi/Projects/content_creation/wechat_duanshipin/productions/2026-W23', repoUrl: null, defaultBranch: null, status: 'active' },
  { projectKey: 'family-first-ai-os', displayName: 'family-first-ai-os', aliases: ['family first', 'Family First'], localPathHint: '/Users/mengxi/Projects/family-first-ai-os', repoUrl: null, defaultBranch: null, status: 'active' },
  { projectKey: 'aijia-compass-work', displayName: 'aijia-compass-work', aliases: ['compass'], localPathHint: '/Users/mengxi/Projects/aijia-compass-work', repoUrl: null, defaultBranch: null, status: 'active' }
] as const satisfies readonly ProjectDefinition[];

export const initialProjectMappingRules = [
  { id: 'system:b-roll', pattern: 'B-roll', patternKind: 'keyword', projectKey: 'openmontage', subprojectKey: null, confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:follow-up-mapping', pattern: 'follow-up 自动映射', patternKind: 'keyword', projectKey: 'feishu-adaptor', subprojectKey: null, confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:amy-live', pattern: 'Amy Live', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-voice', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:amy-voice', pattern: 'Amy 语音通话', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-voice', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:amy-wechat', pattern: 'Amy Wechat', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-wechat', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:buyer-amy', pattern: '买家 Amy', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'amy-wechat', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:smartlisting-amy', pattern: 'smartlisting 上的amy', patternKind: 'keyword', projectKey: 'realagent-ai-cc', subprojectKey: 'smartlisting-amy', confidenceHint: 'high', priority: 100, source: 'system', active: true },
  { id: 'system:jingjie-audiobook', pattern: '静姐有声书', patternKind: 'keyword', projectKey: 'ljhooker-audiobooks', subprojectKey: null, confidenceHint: 'high', priority: 90, source: 'system', active: true },
  { id: 'system:family-first', pattern: 'family first', patternKind: 'keyword', projectKey: 'family-first-ai-os', subprojectKey: null, confidenceHint: 'high', priority: 90, source: 'system', active: true },
  { id: 'system:landing-page', pattern: 'landing page', patternKind: 'keyword', projectKey: 'aijia-landingpage', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:homepage', pattern: '首页', patternKind: 'keyword', projectKey: 'aijia-landingpage', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:wechat-official-account', pattern: '公众号', patternKind: 'keyword', projectKey: 'james-wechat', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:xhs', pattern: '小红书', patternKind: 'keyword', projectKey: 'ivy-xhs', subprojectKey: null, confidenceHint: 'medium', priority: 70, source: 'system', active: true },
  { id: 'system:compass', pattern: 'compass', patternKind: 'keyword', projectKey: 'aijia-compass-work', subprojectKey: null, confidenceHint: 'high', priority: 90, source: 'system', active: true }
] as const satisfies readonly ProjectMappingRule[];
