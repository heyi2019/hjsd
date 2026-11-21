import { Form } from "antd";
import { useEffect, useRef, useState } from "react";
import type { Installment, Schedule } from "../../shared/api/types/installments";
import { useAsyncAction } from "../../shared/hooks/useAsyncAction";
import { useRequestSession } from "../../shared/hooks/useLatestRequest";

/** 分期操作弹窗的目标、表单与异步会话。 */
export function useContractModalState(active: boolean) {
  const [payTarget, setPayTarget] = useState<Installment | null>(null);
  const [deliverTarget, setDeliverTarget] = useState<Installment | null>(null);
  const [recoverTarget, setRecoverTarget] = useState<Installment | null>(null);
  const [resaleTarget, setResaleTarget] = useState<Installment | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Installment | null>(null);
  const [settleTarget, setSettleTarget] = useState<Installment | null>(null);
  const [defaultTarget, setDefaultTarget] = useState<Installment | null>(null);
  const [waiveTarget, setWaiveTarget] = useState<Schedule | null>(null);
  const [extendTarget, setExtendTarget] = useState<Schedule | null>(null);
  const actionSession = useRequestSession(JSON.stringify([
    active, payTarget?.id, deliverTarget?.id, recoverTarget?.id, resaleTarget?.id,
    cancelTarget?.id, settleTarget?.id, defaultTarget?.id, waiveTarget?.id, extendTarget?.id,
  ]));
  // 写操作共用防重状态；切换目标时使旧会话失效。
  const write = useAsyncAction();

  // P2-274：各业务弹窗共享同一份 write.error，上一操作的失败提示会残留到其它弹窗。
  // 打开弹窗或切换目标时清空上一操作的错误。
  // 注意：不能把 write 放进依赖——useAsyncAction 每次渲染返回新对象，一旦放入，失败提示被
  // setError 写出后，同一次重渲染就会再次触发 effect 把 error 清掉，反而吞掉失败提示
  // （回归测试 收款提交失败 / P2-274 会因此失败）。write.clearError 本身是稳定引用，可安全调用。
  const prevTargetsRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    const targets: Record<string, unknown> = {
      payTarget, deliverTarget, recoverTarget, resaleTarget,
      cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    };
    const openedNew = Object.keys(targets).some((k) => targets[k] && targets[k] !== prevTargetsRef.current[k]);
    if (openedNew) write.clearError();
    prevTargetsRef.current = targets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payTarget, deliverTarget, recoverTarget, resaleTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget]);
  const [payForm] = Form.useForm();
  const [deliverForm] = Form.useForm();
  const [recoverForm] = Form.useForm();
  const [resaleForm] = Form.useForm();
  const [cancelForm] = Form.useForm();
  const [settleForm] = Form.useForm();
  const [defaultForm] = Form.useForm();
  const [waiveForm] = Form.useForm();
  const [extendForm] = Form.useForm();

  return {
    payTarget, deliverTarget, recoverTarget, resaleTarget, cancelTarget, settleTarget, defaultTarget, waiveTarget, extendTarget,
    setPayTarget, setDeliverTarget, setRecoverTarget, setResaleTarget, setCancelTarget, setSettleTarget, setDefaultTarget, setWaiveTarget, setExtendTarget,
    payForm, deliverForm, recoverForm, resaleForm, cancelForm, settleForm, defaultForm, waiveForm, extendForm,
    actionSession, write,
  };
}
