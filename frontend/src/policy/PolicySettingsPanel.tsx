import { appMessage } from "../shared/ui/appFeedback";
/** 经营规则配置（T19 / BAS-06-01~02）：定义 → 版本 → 发布 → 生效期。
 *
 * 2026-10-26 重构：
 * - 主从双表（左规则清单 / 右选中规则的详情与版本历史），去掉原「顶部下拉 + 全量定义表」的冗余。
 * - 配置改为按规则编码的结构化表单（见 policyConfigSchema），替代裸 JSON 文本框。
 * - 去掉独立「审核」环节：保存即生成新版本并立即发布（发布人取当前登录用户），
 *   页面只保留 `policy.manage` 一个权限门控。
 *
 * 页面红线：
 * - 已发布版本不可改，点「设置配置」会生成新版本并立即发布；
 * - 新版本生效期不得与已有版本重叠。
 */
import { Card, Col, Empty, Row } from "antd";
import { useCallback, useEffect, useState } from "react";
import { policyApi, type PolicyDefinition, type PolicyVersion } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { useSession } from "../shared/state/session";
import { ErrorBanner, FormDrawer, PageHeader, StatRow } from "../shared/ui";
import { useOptionSet } from "../shared/lib/optionSets";
import { today } from "../shared/lib/format";
import { POLICY_CODE_OPTIONS, SCOPE_OPTIONS } from "./policyConstants";
import { PolicyMasterList } from "./PolicyMasterList";
import { PolicyDetail } from "./PolicyDetail";
import { PolicyVersionEditorModal, type PolicyVersionSubmit } from "./PolicyVersionEditorModal";
import { PolicyResolveModal, type PolicyResolveValues, type PolicyResolveResult } from "./PolicyResolveModal";

export function PolicySettingsPanel() {
  // POLICY_TYPE / POLICY_SCOPE_TYPE 是死枚举（值决定规则引擎分支 / CHECK 约束），只放开文案；
  // 词典未加载时回落模块常量，保证零空白。
  const policyTypeOptions = useOptionSet("POLICY_TYPE") ?? POLICY_CODE_OPTIONS;
  const scopeOptions = useOptionSet("POLICY_SCOPE_TYPE") ?? SCOPE_OPTIONS;
  const { can } = useSession();
  const canManage = can("policy.manage");

  const [definitions, setDefinitions] = useState<PolicyDefinition[]>([]);
  const [definitionId, setDefinitionId] = useState<number | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [definitionsReady, setDefinitionsReady] = useState(false);
  const [versionsReady, setVersionsReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [supersedeTarget, setSupersedeTarget] = useState<PolicyVersion | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<PolicyResolveResult | null>(null);

  const current = definitions.find((d) => d.id === definitionId) ?? null;

  const loadDefinitions = useCallback(async () => {
    setDefinitionsReady(false);
    try {
      const data = await policyApi.list();
      setDefinitions(data.items);
      setDefinitionId((prev) => prev ?? data.items[0]?.id ?? null);
      setError(null);
      setDefinitionsReady(true);
    } catch (err) {
      setError(normalizeError(err));
    }
  }, []);

  useEffect(() => {
    void loadDefinitions();
  }, [loadDefinitions]);

  const loadVersions = useCallback(async () => {
    if (definitionId === null) {
      setVersions([]);
      setVersionsReady(true);
      return;
    }
    setLoading(true);
    setVersionsReady(false);
    try {
      const data = await policyApi.versions(definitionId);
      setVersions(data.items);
      setError(null);
      setVersionsReady(true);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [definitionId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActing(true);
      setError(null);
      try {
        await fn();
        await loadDefinitions();
        await loadVersions();
        return true;
      } catch (err) {
        setError(normalizeError(err));
        return false;
      } finally {
        setActing(false);
      }
    },
    [loadDefinitions, loadVersions],
  );

  /** 保存即发布：新建版本后立即发布（后端取当前登录用户为发布人，无独立审批环节）。 */
  const submitVersion = async (values: PolicyVersionSubmit) => {
    if (!current) return;
    const succeeded = await act(async () => {
      await policyApi.createVersion(current.id, values);
    });
    if (!succeeded) return;
    setEditorOpen(false);
  };

  /** 取消草稿版本：草稿只是未发布的规划，取消不影响任何历史订单口径。 */
  const submitSupersede = async (values: Record<string, unknown>) => {
    const target = supersedeTarget;
    if (!target) return;
    const succeeded = await act(async () => {
      await policyApi.supersede(target.id, { reason: String(values.reason ?? "") });
    });
    if (succeeded) {
      setSupersedeTarget(null);
      appMessage.success(`草稿 v${target.version} 已取消`);
    }
  };

  /** 过期清扫：只固化状态，不改生效期与参数；可重复执行。 */
  const runExpireSweep = async () => {
    const result = await policyApi.expireSweep(today());
    await loadVersions();
    appMessage.success(
      result.swept > 0 ? `已固化 ${result.swept} 个过期版本为「已失效」` : "没有需要固化的过期版本",
    );
  };

  const submitResolve = async (values: PolicyResolveValues) => {
    setResolving(true);
    setError(null);
    try {
      setResolveResult(
        await policyApi.resolve(values.policy_code, values.on, {
          scope_type: values.scope_type || "GLOBAL",
          scope_id:
            values.scope_type && values.scope_type !== "GLOBAL" && values.scope_id
              ? Number(values.scope_id)
              : undefined,
        }),
      );
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setResolving(false);
    }
  };

  const openResolve = () => {
    setResolveResult(null);
    setResolveOpen(true);
  };

  const policyDataReady = definitionsReady && versionsReady;

  return (
    <section className="ui-stack">
      <PageHeader
        title="经营规则"
        description="规则由系统预置并直接生效；点「设置配置」即生成新版本并发布，历史版本保留可查。"
      />

      <ErrorBanner
        error={error}
        onRetry={() => void (definitionId === null ? loadDefinitions() : loadVersions())}
        retrying={loading}
      />

      <StatRow
        items={[
          { label: "规则总数", kind: "count", amount: policyDataReady ? String(definitions.length) : error ? "不可用" : "—" },
          { label: "已发布", kind: "count", amount: policyDataReady ? String(versions.filter((v) => v.status === "ACTIVE").length) : error ? "不可用" : "—" },
          { label: "草稿版本", kind: "count", amount: policyDataReady ? String(versions.filter((v) => v.status === "DRAFT").length) : error ? "不可用" : "—" },
          { label: "当前规则", kind: "count", amount: policyDataReady && current ? current.name : error ? "不可用" : "—" },
        ]}
      />

      <Row gutter={16} className="policy-split">
        <Col xs={24} lg={9}>
          <PolicyMasterList
            definitions={definitions}
            selectedId={definitionId}
            onSelect={setDefinitionId}
            scopeOptions={scopeOptions}
          />
        </Col>
        <Col xs={24} lg={15}>
          {current ? (
            <PolicyDetail
              definition={current}
              versions={versions}
              loading={loading}
              scopeOptions={scopeOptions}
              canManage={canManage && policyDataReady && !error}
              onOpenEditor={() => setEditorOpen(true)}
              onOpenResolve={openResolve}
              onSupersede={setSupersedeTarget}
              onExpireSweep={runExpireSweep}
            />
          ) : (
            <Card className="glass">
              <Empty description="请选择左侧规则" />
            </Card>
          )}
        </Col>
      </Row>

      {current ? (
        <PolicyVersionEditorModal
          open={editorOpen}
          code={current.policy_code}
          initialConfig={versions.find((v) => v.status === "ACTIVE")?.config ?? {}}
          confirmLoading={acting}
          onCancel={() => setEditorOpen(false)}
          onOk={submitVersion}
        />
      ) : null}

      <PolicyResolveModal
        open={resolveOpen}
        initialCode={current?.policy_code}
        policyTypeOptions={policyTypeOptions}
        scopeOptions={scopeOptions}
        resolving={resolving}
        result={resolveResult}
        onCancel={() => setResolveOpen(false)}
        onOk={submitResolve}
      />

      <FormDrawer
        open={supersedeTarget !== null}
        title={`取消草稿 · v${supersedeTarget?.version ?? ""}`}
        fields={[{ name: "reason", label: "取消理由", required: true, kind: "textarea" as const }]}
        submitText="确认取消"
        submitting={acting}
        error={error}
        onClose={() => setSupersedeTarget(null)}
        onSubmit={(values) => void submitSupersede(values)}
        extra={
          <p className="ui-drawer-hint">
            只有草稿版本可取消。已发布版本是历史日期的解析口径，取消会挖掉历史规则的落点；
            要下线生效中的版本，请「设置配置」新建版本并把生效期接上。
          </p>
        }
      />
    </section>
  );
}
