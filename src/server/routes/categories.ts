// ABOUTME: 分类体系与标签的读写路由。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { Category } from '../../contracts/app';
import { asObject, optInt, optString, pathParam, reqString } from '../../contracts/input';
import { api } from '../http';
import { listCategories } from '../repo';
import { row, run, numOr, strOr } from '../sql';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function readColor(body: Record<string, unknown>): string | undefined {
  const value = optString(body, 'color', 7);
  if (value === undefined) return undefined;
  if (!HEX_COLOR.test(value)) throw Object.assign(new Error('颜色需为 #RRGGBB 格式'), { code: 'INVALID_COLOR' });
  return value.toLowerCase();
}

export function registerCategoryRoutes(app: WorkbenchServer): void {
  app.route(
    'GET',
    '/api/categories',
    api((context): Category[] => listCategories(context.database)),
  );

  app.route(
    'POST',
    '/api/categories',
    api((context): Category[] => {
      const body = asObject(context.body);
      const name = reqString(body, 'name', 24);
      const color = readColor(body) ?? '#237a63';
      const icon = optString(body, 'icon', 40) || 'folder';
      const description = optString(body, 'description', 200) ?? null;
      const duplicate = row(context.database, 'SELECT id FROM categories WHERE name = ?', [name]);
      if (duplicate) throw Object.assign(new Error('已存在同名分类'), { code: 'DUPLICATE' });
      const slug = `custom_${Date.now().toString(36)}`;
      const maxOrder = numOr(
        row(context.database, 'SELECT MAX(sort_order) AS m FROM categories')?.m,
        100,
      );
      run(
        context.database,
        'INSERT INTO categories (slug, name, color, icon, description, sort_order, is_system) VALUES (?, ?, ?, ?, ?, ?, 0)',
        [slug, name, color, icon, description, Math.max(maxOrder, 100) + 1],
      );
      return listCategories(context.database);
    }),
  );

  app.route(
    'PATCH',
    '/api/categories/:id',
    api((context): Category[] => {
      const id = pathParam(context.params, 'id');
      const body = asObject(context.body);
      const existing = row(context.database, 'SELECT id FROM categories WHERE id = ?', [id]);
      if (!existing) throw Object.assign(new Error('分类不存在'), { code: 'NOT_FOUND' });

      const name = optString(body, 'name', 24);
      const color = readColor(body);
      const icon = optString(body, 'icon', 40);
      const description = optString(body, 'description', 200);
      const sortOrder = optInt(body, 'sortOrder', 0, 9999);
      if (name) run(context.database, 'UPDATE categories SET name = ? WHERE id = ?', [name, id]);
      if (color) run(context.database, 'UPDATE categories SET color = ? WHERE id = ?', [color, id]);
      if (icon) run(context.database, 'UPDATE categories SET icon = ? WHERE id = ?', [icon, id]);
      if (description !== undefined) run(context.database, 'UPDATE categories SET description = ? WHERE id = ?', [description || null, id]);
      if (sortOrder !== undefined) run(context.database, 'UPDATE categories SET sort_order = ? WHERE id = ?', [sortOrder, id]);
      return listCategories(context.database);
    }),
  );

  app.route(
    'DELETE',
    '/api/categories/:id',
    api((context): Category[] => {
      const id = pathParam(context.params, 'id');
      const existing = row(context.database, 'SELECT id, is_system, slug FROM categories WHERE id = ?', [id]);
      if (!existing) throw Object.assign(new Error('分类不存在'), { code: 'NOT_FOUND' });
      if (numOr(existing.is_system, 0) === 1) {
        throw Object.assign(new Error('内置分类不能删除，可以改名或改颜色'), { code: 'SYSTEM_CATEGORY' });
      }
      const fallback = row(context.database, "SELECT id FROM categories WHERE slug = 'uncategorized'");
      run(context.database, 'UPDATE recordings SET category_id = ? WHERE category_id = ?', [numOr(fallback?.id, 0) || null, id]);
      run(context.database, 'DELETE FROM categories WHERE id = ?', [id]);
      return listCategories(context.database);
    }),
  );
}

export function categorySlugOf(db: Parameters<typeof listCategories>[0], id: number | null): string {
  if (id === null) return 'uncategorized';
  const found = row(db, 'SELECT slug FROM categories WHERE id = ?', [id]);
  return found ? strOr(found.slug, 'uncategorized') : 'uncategorized';
}
