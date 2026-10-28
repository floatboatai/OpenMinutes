// ABOUTME: 设置页：录音库位置、自动转录与自动重连、识别参数。

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import type { SettingEntry } from '../../contracts/app';
import { api, errorText } from '../api';
import { useAsyncData } from '../useApi';
import { Button, Card, ErrorState, Field, Loading, useToast } from '../components/ui';

const TEXT_FIELDS: Array<{ key: string; label: string; hint: string; placeholder: string }> = [
  {
    key: 'library_dir',
    label: '录音库目录',
    hint: '留空默认 ~/memo/memotalk/raw，拉取的录音按 YYYY-MM 自动分月归档',
    placeholder: '~/memo/memotalk/raw',
  },
  { key: 'import_dir', label: '导入目录', hint: '扫描导入时读取的本地目录', placeholder: '~/Downloads' },
  { key: 'python_path', label: 'Python 解释器', hint: '留空时自动使用 Floatboat 内置 Python', placeholder: 'python' },
  { key: 'ffmpeg_path', label: 'ffmpeg 路径', hint: '留空时使用 Floatboat 内置 ffmpeg；转录依赖它解码音频', placeholder: 'ffmpeg' },
];

const FLAG_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'auto_transcribe', label: '拉取/导入后自动转录', hint: '新录音进库后立即排队识别，无需手动点「开始转录」' },
  { key: 'auto_analyze', label: '转录后自动归类', hint: '转录完成立即调用 AI 生成摘要与分类' },
  { key: 'auto_connect', label: '自动重连录音笔', hint: '工作台打开时定期静默探测，设备唤醒后自动接上；不唤醒已休眠的设备' },
  {
    key: 'auto_pull',
    label: '连上后自动拉取',
    hint: '连上设备即读清单并逐个下载待拉取录音；单轮最多 3 个文件、约 2.5 分钟预算',
  },
  { key: 'speaker_diarization', label: '启用说话人分离', hint: '让识别结果区分不同说话人；较长录音耗时略增' },
];

const NUM_FIELDS: Array<{ key: string; label: string; hint: string; min: number; max: number }> = [
  { key: 'auto_connect_minutes', label: '自动重连间隔（分钟）', hint: '每次探测约占用设备 10 秒；间隔越短越及时，也越耗电', min: 1, max: 120 },
];

export function SettingsPage() {
  const toast = useToast();
  const state = useAsyncData<SettingEntry[]>(() => api.get<SettingEntry[]>('/api/settings'), 'settings');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.data) {
      const next: Record<string, string> = {};
      for (const entry of state.data) next[entry.key] = entry.value;
      setDraft(next);
    }
  }, [state.data]);

  if (state.loading && !state.data) return <Loading label="正在读取设置" />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  const value = (key: string): string => draft[key] ?? '';
  const update = (key: string, next: string) => setDraft((current) => ({ ...current, [key]: next }));

  const save = async () => {
    setBusy(true);
    try {
      const values: Record<string, string> = {};
      for (const field of TEXT_FIELDS) values[field.key] = value(field.key);
      for (const field of FLAG_FIELDS) values[field.key] = value(field.key) === '1' ? '1' : '0';
      for (const field of NUM_FIELDS) values[field.key] = value(field.key) || String(field.min);
      values.asr_hotwords = value('asr_hotwords');
      values.asr_language = value('asr_language');
      await api.patch('/api/settings', { values });
      toast.push('设置已保存', 'success');
      state.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page--settings">
      <header className="page__head">
        <div>
          <h1>设置</h1>
          <p className="page__sub">这些设置只保存在本机应用数据里，不会上传任何凭据。</p>
        </div>
        <div className="page__actions">
          <Button variant="primary" icon={<Save size={15} aria-hidden="true" />} disabled={busy} onClick={() => void save()}>
            保存设置
          </Button>
        </div>
      </header>

      <div className="device-grid">
        <Card title="路径">
          {TEXT_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <input value={value(field.key)} placeholder={field.placeholder} onChange={(event) => update(field.key, event.target.value)} />
            </Field>
          ))}
        </Card>

        <Card title="自动化">
          {FLAG_FIELDS.map((field) => (
            <label key={field.key} className="switch switch--row">
              <input
                type="checkbox"
                checked={value(field.key) === '1'}
                onChange={(event) => update(field.key, event.target.checked ? '1' : '0')}
              />
              <span>
                <span className="switch__label">{field.label}</span>
                <span className="switch__hint">{field.hint}</span>
              </span>
            </label>
          ))}
          {NUM_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <input
                type="number"
                min={field.min}
                max={field.max}
                value={value(field.key)}
                disabled={value('auto_connect') !== '1'}
                onChange={(event) => update(field.key, event.target.value)}
              />
            </Field>
          ))}
        </Card>

        <Card title="识别">
          <Field label="识别热词" hint="用逗号分隔，提升专有名词识别率">
            <input
              value={value('asr_hotwords')}
              placeholder="例如：MemoTalk, 复购率, 私域"
              onChange={(event) => update('asr_hotwords', event.target.value)}
            />
          </Field>
          <Field label="识别语言" hint="留空由识别引擎自动判断">
            <select value={value('asr_language')} onChange={(event) => update('asr_language', event.target.value)}>
              <option value="">自动</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
              <option value="ja">日文</option>
            </select>
          </Field>
        </Card>
      </div>
    </div>
  );
}
