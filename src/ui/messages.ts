// ABOUTME: 集中维护骨架的双语文案。

const messages = {
  'zh-CN': { loading: '正在加载', empty: '暂无内容', failure: '暂时无法加载', retry: '重试' },
  en: { loading: 'Loading', empty: 'No content yet', failure: 'Unable to load', retry: 'Retry' },
};

export function text(key: keyof typeof messages.en): string {
  return messages[document.documentElement.lang.startsWith('zh') ? 'zh-CN' : 'en'][key];
}
