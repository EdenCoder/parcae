import { Model } from '@parcae/model';
import type { QueryChain, ScopeContext } from '@parcae/model';

const tenantId = (ctx: ScopeContext): string | null => {
  const value = ctx.user?.tenantId;
  return typeof value === 'string' ? value : null;
};

const tenantScope = (ctx: ScopeContext) => {
  const value = tenantId(ctx);
  return value
    ? (query: QueryChain<Document>) => query.where('tenantId', value)
    : null;
};

export class Document extends Model {
  static type = 'document' as const;
  static readonly readonlyFields = ['tenantId', 'revision'];
  static readonly privateFields = ['secret'];
  static scope = {
    read: tenantScope,
    create: (ctx: ScopeContext) => {
      const value = tenantId(ctx);
      return value ? { tenantId: value, revision: 0 } : null;
    },
    update: tenantScope,
    patch: tenantScope,
  };

  tenantId: string = '';
  title: string = '';
  revision: number = 0;
  secret: string = '';
}
