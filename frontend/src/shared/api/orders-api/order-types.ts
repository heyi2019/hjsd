import { api } from "../client";
import type { OrderType } from "../types/orders";

export const orderTypesApi = {
  update: (id: number, data: Partial<OrderType>) => api.patch<OrderType>(`/order-types/${id}`, data).then(r => r.data),
  setActive: (id: number, is_active: boolean) => api.patch<OrderType>(`/order-types/${id}/active`, {is_active}).then(r => r.data),
  list: () => api.get<OrderType[]>("/order-types").then((r) => r.data),
  create: (payload: Partial<OrderType>) =>
    api.post<OrderType>("/order-types", payload).then((r) => r.data),
};
