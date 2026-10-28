// ABOUTME: 分类管理：新增、改名、改色、删除自定义分类。

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Category } from '../../contracts/app';
import { api, errorText } from '../api';
import { useAsyncData } from '../useApi';
import { Button, Card, Empty, ErrorState, Field, Loading, useToast } from '../components/ui';

const PALETTE = ['#2563eb', '#7c3aed', '#d97706', '#dc2626', '#0891b2', '#be185d', '#059669', '#475569'];

export function CategoriesPage() {
  const toast = useToast();
  const state = useAsyncData<Category[]>(() => api.get<Category[]>('/api/categories'), 'categories');
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0]);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const categories = state.data ?? [];
  const total = categories.reduce((sum, item) => sum + item.recordingCount, 0);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/categories', { name: name.trim(), color, description: description.trim() });
      setName('');
      setDescription('');
      toast.push('分类已创建', 'success');
      state.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (category: Category, nextName: string) => {
    if (!nextName.trim() || nextName === category.name) return;
    try {
      await api.patch(`/api/categories/${category.id}`, { name: nextName.trim() });
      toast.push('分类已更新', 'success');
      state.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    }
  };

  const recolor = async (category: Category, nextColor: string) => {
    try {
      await api.patch(`/api/categories/${category.id}`, { color: nextColor });
      state.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    }
  };

  const remove = async (category: Category) => {
    if (!window.confirm(`删除分类「${category.name}」？其中的录音会回到未分类。`)) return;
    try {
      await api.remove(`/api/categories/${category.id}`);
      toast.push('分类已删除', 'success');
      state.reload();
    } catch (error) {
      toast.push(errorText(error), 'error');
    }
  };

  if (state.loading && !state.data) return <Loading label="正在读取分类" />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;

  return (
    <div className="page page--categories">
      <header className="page__head">
        <div>
          <h1>分类体系</h1>
          <p className="page__sub">
            共 {categories.length} 个分类，覆盖 {total} 条录音。AI 归类时会从这些分类中选择最贴切的一个。
          </p>
        </div>
      </header>

      <div className="device-grid">
        <Card title="新增分类">
          <Field label="名称" hint="不超过 12 个字，便于列表展示">
            <input value={name} maxLength={12} onChange={(event) => setName(event.target.value)} placeholder="例如：产品评审" />
          </Field>
          <Field label="颜色">
            <div className="palette" role="group" aria-label="分类颜色">
              {PALETTE.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`palette__swatch${option === color ? ' palette__swatch--on' : ''}`}
                  style={{ background: option }}
                  aria-label={`选择颜色 ${option}`}
                  aria-pressed={option === color}
                  onClick={() => setColor(option)}
                />
              ))}
            </div>
          </Field>
          <Field label="说明" hint="会作为 AI 分类判断依据">
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这类录音通常在什么场景下产生" />
          </Field>
          <div className="card__actions">
            <Button variant="primary" size="sm" icon={<Plus size={14} aria-hidden="true" />} disabled={busy || !name.trim()} onClick={() => void add()}>
              创建分类
            </Button>
          </div>
        </Card>

        <Card title="全部分类">
          {categories.length === 0 ? (
            <Empty title="还没有分类" />
          ) : (
            <ul className="catlist">
              {categories.map((category) => (
                <li key={category.id} className="catlist__row">
                  <input
                    type="color"
                    value={category.color}
                    onChange={(event) => void recolor(category, event.target.value)}
                    aria-label={`${category.name} 的颜色`}
                    className="catlist__color"
                  />
                  <input
                    className="catlist__name"
                    defaultValue={category.name}
                    onBlur={(event) => void rename(category, event.target.value)}
                    aria-label={`${category.name} 的名称`}
                  />
                  <span className="catlist__desc">{category.description ?? '—'}</span>
                  <span className="catlist__count">{category.recordingCount} 条</span>
                  {category.isSystem ? (
                    <span className="muted catlist__lock">内置</span>
                  ) : (
                    <Button size="sm" variant="quiet" icon={<Trash2 size={13} aria-hidden="true" />} onClick={() => void remove(category)}>
                      删除
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
