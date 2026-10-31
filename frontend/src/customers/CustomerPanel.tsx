import { SearchOutlined } from "@ant-design/icons";
import { Button, Card, Descriptions, Drawer, Form, Input, Space, Spin, Typography } from "antd";
import { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useRef, useState } from "react";
import { CfgItem, FieldConfigScope, buildFormExtraDisplay, formatExtraDisplayValue } from "../orders/ConfigurableField";
import { customersApi, orderFormFieldsApi } from "../shared/api/catalog";
import type { Customer, CustomerBusiness, CustomerDetail, CustomerInstallment, OrderFormField } from "../shared/api/catalog";
import { normalizeError } from "../shared/api/client";
import { downloadBlob } from "../shared/api/download";
import { formatDateTimeMinute, money, today } from "../shared/lib/format";
import { orderTypeLabel } from "../shared/lib/labels";
import { columnKey, useListViewColumns } from "../shared/lib/listColumns";
import { configurableLabel, useOptionSet } from "../shared/lib/optionSets";
import { useReloadOnActive } from "../shared/state/reloadOnActive";
import { DataTable, BusinessActionModal, BusinessForm, ErrorBanner, ConfirmButton, PermissionButton, Select, StatRow, StatusTag, useCompactLayout, CompactActions } from "../shared/ui";
import { appMessage } from "../shared/ui/appFeedback";
import { CUSTOMER_ROLE_LABEL, customerDateKey, MobileCustomerList, collectExtras, ExtraFieldControl } from "./CustomersPage.fragments";

const SearchButton = Button;

export function CustomerPanel({ active = true, focusId }: { active?: boolean; focusId?: number }) {
  const compact = useCompactLayout();
  const [rows, setRows] = useState<Customer[]>([]);
  const [fieldDefs, setFieldDefs] = useState<OrderFormField[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [detailTarget, setDetailTarget] = useState<Customer | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Customer | null>(null);
  const [detailData, setDetailData] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 点「查看」后取到的完整联系方式，仅存活于当前会话内存（刷新即回到脱敏值）。 */
  const [revealed, setRevealed] = useState<Record<number, Customer>>({});
  const [revealingId, setRevealingId] = useState<number | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchInput, setSearchInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const customerStatusOptions = useOptionSet("CUSTOMER_STATUS");
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [mergeForm] = Form.useForm();

  const activeDefs = fieldDefs.filter((def) => def.is_active);

  const [exporting, setExporting] = useState(false);
  /** 客户按列配置导出 CSV：后端沿用筛选与联系方式脱敏口径。 */
  const exportCustomers = async () => {
    setExporting(true);
    try {
      downloadBlob(
        await customersApi.exportCsv({
          ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
          ...(statusFilter ? { status: statusFilter } : {}),
        }),
        `客户-${today()}.csv`,
      );
    } catch (err) {
      appMessage.error(normalizeError(err).message);
    } finally {
      setExporting(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await customersApi.list({
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      }));
      setError(null);
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setLoading(false);
    }
  }, [keyword, statusFilter]);

  // keep-alive：建单流程会自动建档客户，重新激活时重拉避免列表过期。
  // 首次挂载由筛选 effect 负责；keep-alive 重新激活时仍由统一入口刷新。
  useReloadOnActive(active, load, { skipFirstMount: true });
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = active;
    // 从隐藏页切回时交给 useReloadOnActive，避免激活瞬间重复请求。
    if (!active || !wasActive) return;
    void load();
  }, [active, keyword, statusFilter, load]);

  useEffect(() => {
    // 扩展字段定义来自「客户建档」表单的自定义字段；加载失败不阻断客户页
    orderFormFieldsApi
      .list("CUSTOMER", true)
      .then((rows) => setFieldDefs((rows ?? []).filter((row) => row.is_custom)))
      .catch(() => setFieldDefs([]));
  }, []);

  const openDetail = async (row: Customer) => {
    setDetailTarget(row);
    setDetailData(null);
    setDetailLoading(true);
    try {
      setDetailData(await customersApi.detail(row.id));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const handledFocusRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusId == null || handledFocusRef.current === focusId) return;
    const row = rows.find((item) => item.id === focusId);
    if (!row) return;
    handledFocusRef.current = focusId;
    void openDetail(row);
  }, [focusId, rows]);

  /** 后端默认脱敏；点「查看」才取明文，后端同时写一条 CONTACT_READ 审计。 */
  const revealContact = async (id: number) => {
    setRevealingId(id);
    try {
      const full = await customersApi.get(id, true);
      setRevealed((prev) => ({ ...prev, [id]: full }));
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setRevealingId(null);
    }
  };

  /** 联系方式单元格：脱敏值 + 「查看」入口；无 contact.read 权限的人拿不到按钮，也拿不到明文。 */
  const renderContact = (row: Customer, field: "phone" | "wechat" | "qq") => {
    const full = revealed[row.id];
    const value = (full ?? row)[field];
    if (!row.contact_masked || full) return value || "-";
    return (
      <Space size={4}>
        <span>{value || "-"}</span>
        <PermissionButton
          permission="customer.contact.read"
          type="link"
          size="small"
          loading={revealingId === row.id}
          onClick={() => void revealContact(row.id)}
        >
          查看
        </PermissionButton>
      </Space>
    );
  };

  const submitCreate = async (values: Record<string, unknown>) => {
    try {
      const extraValues = collectExtras(values, activeDefs);
      const result = await customersApi.create({
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        phone: values.phone as string,
        wechat: values.wechat as string,
        qq: values.qq as string,
        note: (values.note as string) || null,
        extra_values: Object.keys(extraValues).length > 0 ? extraValues : undefined,
      });
      if (result.duplicate_candidates.length > 0) {
        appMessage.warning(`已建档，检测到 ${result.duplicate_candidates.length} 条重复候选（未拦截）`);
      } else {
        appMessage.success("客户已建档");
      }
      setCreateOpen(false);
      form.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitEdit = async (values: Record<string, unknown>) => {
    if (!editTarget) return;
    try {
      const extraValues = collectExtras(values, activeDefs);
      // 脱敏值不可回写：未取得明文时不提交联系方式，避免把 138****1234 覆盖进库。
      const contactsVisible = !editTarget.contact_masked || Boolean(revealed[editTarget.id]);
      await customersApi.patch(editTarget.id, {
        display_name: values.display_name as string,
        contact_name: values.contact_name as string,
        ...(contactsVisible
          ? {
              phone: values.phone as string,
              wechat: values.wechat as string,
              qq: values.qq as string,
            }
          : {}),
        note: (values.note as string) || null,
        extra_values: extraValues,
      });
      appMessage.success("客户已更新");
      setEditTarget(null);
      editForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const submitMerge = async (values: Record<string, unknown>) => {
    if (!mergeTarget) return;
    try {
      await customersApi.merge(
        mergeTarget.id,
        Number(values.target_customer_id),
        values.reason as string,
      );
      appMessage.success("合并完成，来源客户已置 MERGED 并迁移关联关系");
      setMergeTarget(null);
      mergeForm.resetFields();
      await load();
    } catch (err) {
      setError(normalizeError(err));
    }
  };

  const { arrange: arrangeColumns } = useListViewColumns("CUSTOMER");
  const columns: ColumnsType<Customer> = [
    { title: "客户编号", dataIndex: "customer_no" },
    { title: "名字", dataIndex: "display_name" },
    { title: "手机", key: "phone", render: (_v, row) => renderContact(row, "phone") },
    { title: "微信", key: "wechat", render: (_v, row) => renderContact(row, "wechat") },
    { title: "QQ", key: "qq", render: (_v, row) => renderContact(row, "qq") },
    { title: "状态", dataIndex: "status", render: (v: string) => <StatusTag status={v} optionSet="CUSTOMER_STATUS" /> },
    { title: "建立时间", dataIndex: "created_at", render: (v: string | null | undefined) => formatDateTimeMinute(v) },
    {
      title: "扩展字段",
      key: "extra_values",
      render: (_v, row) => {
        const items = buildFormExtraDisplay(row.extra_values, fieldDefs);
        if (items.length === 0) return "-";
        const shown = items.slice(0, 2).map((it) =>
          `${it.label}${it.status === "deleted" ? "（已删除）" : it.status === "inactive" ? "（已停用）" : ""}：${formatExtraDisplayValue(it.value)}`);
        return items.length > 2 ? `${shown.join("；")} 等 ${items.length} 项` : shown.join("；");
      },
    },
    {
      title: "操作",
      key: "actions",
      render: (_v, row) => (
        <Space size={2}>
          <PermissionButton permission="customer.read" size="small" onClick={() => void openDetail(row)}>
            详情
          </PermissionButton>
          <PermissionButton
            permission="customer.merge"
            size="small"
            disabled={row.status !== "ACTIVE"}
            onClick={() => setMergeTarget(row)}
          >
            合并
          </PermissionButton>
          <ConfirmButton
            permission="customer.update"
            size="small"
            title={row.status === "ACTIVE" ? "拉黑该客户" : "解除拉黑"}
            description={row.status === "ACTIVE"
              ? "拉黑后不可作为新订单参与方；历史订单、分期与需求保留。"
              : "解除后可重新作为新订单参与方。"}
            danger={row.status === "ACTIVE"}
            onConfirm={async () => {
              await customersApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE");
              appMessage.success(row.status === "ACTIVE" ? "客户已拉黑，历史关系保留" : "客户已解除拉黑");
              await load();
            }}
          >
            {row.status === "ACTIVE" ? "拉黑" : "解除拉黑"}
          </ConfirmButton>
        </Space>
      ),
    },
  ];
  const mobileFieldOrder = arrangeColumns(columns).map(columnKey);

  const currentDate = today();
  const newThisMonthCount = rows.filter((row) => customerDateKey(row.created_at)?.startsWith(currentDate.slice(0, 7))).length;
  const newTodayCount = rows.filter((row) => customerDateKey(row.created_at) === currentDate).length;

  return (
    <Card
      className="glass"
      title="客户档案"
      extra={
        <Space>
          <Button
            size="small"
            aria-label="导出客户CSV"
            loading={exporting}
            onClick={() => void exportCustomers()}
          >
            导出 CSV
          </Button>
          <PermissionButton permission="customer.create" type="primary" onClick={() => setCreateOpen(true)}>
            新建客户
          </PermissionButton>
        </Space>
      }
    >
      <ErrorBanner error={error} onRetry={() => void load()} />
      <Typography.Paragraph type="secondary">
        联系方式默认脱敏；完整联系方式按权限展示并记录读取审计。拉黑/已合并客户不可作为新订单参与方。
      </Typography.Paragraph>
      <StatRow
        items={[
          { label: "客户总数", kind: "count", amount: String(rows.length) },
          { label: "本月新增客户数", kind: "count", amount: String(newThisMonthCount) },
          { label: "今日新增客户数", kind: "count", amount: String(newTodayCount) },
        ]}
      />
      <Space wrap className="customer-list-filters customer-list-filters--separated">
        <Input.Search
          aria-label="搜索客户"
          enterButton={<SearchButton icon={<SearchOutlined />} aria-label="搜索客户" />}
          value={searchInput}
          allowClear
          placeholder="搜索客户编号 / 名字 / 手机 / 微信 / QQ"
          onChange={(event) => {
            setSearchInput(event.target.value);
            if (!event.target.value) {
              setKeyword("");
              setPage(1);
            }
          }}
          onSearch={(value) => {
            setKeyword(value);
            setPage(1);
          }}
        />
        <Select
          aria-label="客户状态"
          allowClear
          placeholder="全部状态"
          value={statusFilter}
          options={customerStatusOptions ?? []}
          onChange={(value) => {
            setStatusFilter(value);
            setPage(1);
          }}
        />
      </Space>
      {!compact ? <DataTable<Customer>
        columns={arrangeColumns(columns)}
        rows={rows}
        loading={loading}
        page={page}
        pageSize={pageSize}
        total={rows.length}
        className="customer-table"
       
        emptyText="暂无客户档案"
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage);
          setPageSize(nextSize);
        }}
      /> : <MobileCustomerList
        rows={rows}
        onDetail={(row) => void openDetail(row)}
        onMerge={setMergeTarget}
        renderPhone={(row) => renderContact(row, "phone")}
        fieldOrder={mobileFieldOrder}
        onDisable={async (row) => {
          await customersApi.setStatus(row.id, row.status === "ACTIVE" ? "DISABLED" : "ACTIVE");
          appMessage.success(row.status === "ACTIVE" ? "客户已拉黑，历史关系保留" : "客户已解除拉黑");
          await load();
        }}
      />}

      <BusinessActionModal title="新建客户" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <FieldConfigScope scope="CUSTOMER" active={createOpen}>
        <BusinessForm scope="CUSTOMER" form={form} colon={false} className="form-no-colon" onFinish={submitCreate}>
          <CfgItem name="display_name" label="名字" rules={[{ required: true }]}>
            <Input />
          </CfgItem>
          {/* 短字段两列一行，压弹窗高度（称呼为必填主字段保持整行） */}
          <div className="form-cols-2">
            <CfgItem name="contact_name" label="联系人姓名">
              <Input />
            </CfgItem>
            <CfgItem name="phone" label="手机号">
              <Input />
            </CfgItem>
            <CfgItem name="wechat" label="微信号">
              <Input />
            </CfgItem>
            <CfgItem name="qq" label="QQ">
              <Input />
            </CfgItem>
          </div>
          <CfgItem name="note" label="备注">
            <Input.TextArea rows={3} placeholder="选填：客户来源、偏好、注意事项等" />
          </CfgItem>
          {activeDefs.map((def) => (
            <Form.Item
              key={def.field_key}
              name={def.field_key}
              label={def.label}
              valuePropName={def.field_type === "BOOLEAN" ? "checked" : "value"}
              rules={def.required ? [{ required: true, message: `请填写${def.label}` }] : []}
            >
              <ExtraFieldControl def={def} />
            </Form.Item>
          ))}
          <Typography.Paragraph type="secondary">
            联系方式允许重复；重复只提示候选，不拦截建档。扩展字段在「设置 › 表单字段 › 客户建档」维护，可随时增删。
          </Typography.Paragraph>
          <PermissionButton permission="customer.create" type="primary" htmlType="submit">
            建档
          </PermissionButton>
        </BusinessForm>
        </FieldConfigScope>
      </BusinessActionModal>

      <BusinessActionModal
        title={editTarget ? `编辑客户 · ${editTarget.customer_no}` : "编辑客户"}
        open={Boolean(editTarget)}
        onCancel={() => {
          setEditTarget(null);
          editForm.resetFields();
        }}
        footer={null}
        destroyOnHidden
      >
        <BusinessForm
          scope="CUSTOMER"
          form={editForm}
          layout="vertical"
          colon={false}
          className="form-no-colon"
          onFinish={submitEdit}
          initialValues={
            editTarget
              ? {
                  display_name: editTarget.display_name,
                  contact_name: editTarget.contact_name ?? "",
                  // 点过「查看」则用明文填表，否则留空——脱敏值不能进编辑表单。
                  phone: (revealed[editTarget.id] ?? editTarget).phone ?? "",
                  wechat: (revealed[editTarget.id] ?? editTarget).wechat ?? "",
                  qq: (revealed[editTarget.id] ?? editTarget).qq ?? "",
                  note: editTarget.note ?? "",
                  ...Object.fromEntries(
                    activeDefs.map((def) => [def.field_key, editTarget.extra_values?.[def.field_key]]),
                  ),
                }
              : undefined
          }
        >
          <Form.Item name="display_name" label="名字" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <div className="form-cols-2">
            <Form.Item name="contact_name" label="联系人姓名">
              <Input />
            </Form.Item>
            <Form.Item name="phone" label="手机号">
              <Input />
            </Form.Item>
            <Form.Item name="wechat" label="微信号">
              <Input />
            </Form.Item>
            <Form.Item name="qq" label="QQ">
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
          {activeDefs.map((def) => (
            <Form.Item
              key={def.field_key}
              name={def.field_key}
              label={def.label}
              valuePropName={def.field_type === "BOOLEAN" ? "checked" : "value"}
              rules={def.required ? [{ required: true, message: `请填写${def.label}` }] : []}
            >
              <ExtraFieldControl def={def} />
            </Form.Item>
          ))}
          <PermissionButton permission="customer.update" type="primary" htmlType="submit">
            保存
          </PermissionButton>
        </BusinessForm>
      </BusinessActionModal>

      <Drawer
        title={detailTarget ? `客户档案 · ${detailTarget.customer_no}` : "客户档案"}
        open={Boolean(detailTarget)}
        onClose={() => {
          setDetailTarget(null);
          setDetailData(null);
        }}
        width={720}
        destroyOnHidden
        extra={
          detailTarget && detailTarget.status === "ACTIVE" ? (
            <PermissionButton
              permission="customer.update"
              size="small"
              onClick={() => {
                setEditTarget(detailTarget);
                setDetailTarget(null);
              }}
            >
              编辑
            </PermissionButton>
          ) : null
        }
      >
        {detailLoading ? (
          <div role="status" aria-label="正在加载客户详情"><Spin /></div>
        ) : detailTarget ? (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="客户编号">{detailTarget.customer_no}</Descriptions.Item>
              <Descriptions.Item label="名字">{detailTarget.display_name}</Descriptions.Item>
              <Descriptions.Item label="联系人">{detailTarget.contact_name || "-"}</Descriptions.Item>
              <Descriptions.Item label="手机">{detailTarget ? renderContact(detailTarget, "phone") : "-"}</Descriptions.Item>
              <Descriptions.Item label="微信">{detailTarget ? renderContact(detailTarget, "wechat") : "-"}</Descriptions.Item>
              <Descriptions.Item label="QQ">{detailTarget ? renderContact(detailTarget, "qq") : "-"}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <StatusTag status={detailTarget.status} optionSet="CUSTOMER_STATUS" />
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detailTarget.note || "-"}</Descriptions.Item>
            </Descriptions>
            <Typography.Title level={5} className="ui-title-spaced">
              扩展字段
            </Typography.Title>
            {(() => {
              const items = buildFormExtraDisplay(detailTarget.extra_values, fieldDefs);
              if (items.length === 0) {
                return (
                  <Typography.Paragraph type="secondary">
                    {fieldDefs.length === 0
                      ? "未配置扩展字段；在「设置 › 表单字段 › 客户建档」新增自定义字段后，建档与详情会自动带出。"
                      : "无扩展字段值"}
                  </Typography.Paragraph>
                );
              }
              return (
                <Descriptions column={1} bordered size="small">
                  {items.map((it) => (
                    <Descriptions.Item
                      key={it.key}
                      label={`${it.label}${it.status === "deleted" ? "（已删除）" : it.status === "inactive" ? "（已停用）" : ""}`}
                    >
                      {formatExtraDisplayValue(it.value) || "未填写"}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
              );
            })()}
            {detailData ? (
              <>
                <Typography.Title level={5} className="ui-title-spaced">经营概览</Typography.Title>
                <StatRow
                  items={[
                    { label: "关联订单", amount: detailData.overview.order_count, kind: "count" },
                    { label: "进行中订单", amount: detailData.overview.active_order_count, kind: "count" },
                    { label: "已完成订单", amount: detailData.overview.completed_order_count, kind: "count" },
                    { label: "分期已收", amount: detailData.overview.installment_paid_total, kind: "money" },
                    { label: "分期应收", amount: detailData.overview.installment_receivable_total, kind: "money" },
                    { label: "剩余应收", amount: detailData.overview.installment_remaining_total, kind: "money", tone: "warn" },
                    { label: "逾期期数", amount: detailData.overview.overdue_period_count, kind: "count", tone: detailData.overview.overdue_period_count > 0 ? "warn" : "plain" },
                  ]}
                />
                <Typography.Title level={5} className="ui-title-spaced">关联订单</Typography.Title>
                <DataTable<CustomerBusiness>
                  columns={[
                    { title: "订单", dataIndex: "order_no" },
                    { title: "业务", render: (_value, row) => orderTypeLabel(row.order_type) },
                    {
                      title: "角色",
                      render: (_value, row) =>
                        row.roles
                          .map((role) => configurableLabel("ORDER_CUSTOMER_ROLE", role, CUSTOMER_ROLE_LABEL))
                          .join("、") || "-",
                    },
                    { title: "状态", render: (_value, row) => <StatusTag status={row.status} optionSet="ORDER_STATUS" /> },
                    { title: "日期", dataIndex: "trade_date" },
                  ]}
                  rows={detailData.business}
                  page={1}
                  pageSize={detailData.business.length || 1}
                  total={detailData.business.length}
                  onPageChange={() => undefined}
                  pagination={false}
                  emptyText="暂无关联订单"
               />
                <Typography.Title level={5} className="ui-title-spaced">分期收款</Typography.Title>
                <DataTable<CustomerInstallment>
                  columns={[
                    { title: "合约", dataIndex: "inst_no" },
                    { title: "订单", dataIndex: "order_no" },
                    { title: "状态", render: (_value, row) => <StatusTag status={row.status} optionSet="INSTALLMENT_STATUS" /> },
                    { title: "已收", render: (_value, row) => `¥${money(row.paid_amount)}` },
                    { title: "剩余", render: (_value, row) => `¥${money(row.remaining_amount)}` },
                    { title: "逾期", render: (_value, row) => row.overdue_periods > 0 ? `逾期 ${row.overdue_periods} 期` : "-" },
                  ]}
                  rows={detailData.installments}
                  page={1}
                  pageSize={detailData.installments.length || 1}
                  total={detailData.installments.length}
                  onPageChange={() => undefined}
                  pagination={false}
                  emptyText="暂无分期合约"
               />
              </>
            ) : null}
          </>
        ) : null}
      </Drawer>

      <BusinessActionModal size="compact"
        title={mergeTarget ? `合并客户 · ${mergeTarget.customer_no}` : "合并客户"}
        open={Boolean(mergeTarget)}
        onCancel={() => setMergeTarget(null)}
        footer={null}
      >
        <BusinessForm scope="CUSTOMER" form={mergeForm} colon={false} className="form-no-colon" onFinish={submitMerge}>
          <Form.Item name="target_customer_id" label="目标客户（必须为 ACTIVE）" rules={[{ required: true }]}>
            <Select
              options={rows
                .filter((row) => row.status === "ACTIVE" && row.id !== mergeTarget?.id)
                .map((row) => ({ value: row.id, label: `${row.customer_no} ${row.display_name}` }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="合并原因" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <CompactActions>
            <PermissionButton permission="customer.merge" type="primary" htmlType="submit">
              确认合并
            </PermissionButton>
          </CompactActions>
        </BusinessForm>
      </BusinessActionModal>
    </Card>
  );
}

