/** 建单表单字段配置驱动：拉取某业务类型的 OrderFormField 配置，并提供
 *  - FieldConfigContext / useFieldConfig：CreateBusinessModal 把配置注入此 context，各 Section 默认从此读取
 *  - CfgItem：受配置驱动的 Form.Item（停用字段不渲染、必填/标签从配置读）
 *  - CfgNestedItem：同上，但渲染在 BusinessRegistrationField 布局内（name 在内层 Form.Item）
 *  - CustomFormField：渲染用户自定义字段（值归集到 form_extra.<field_key>）
 *  降级策略：配置未加载或某字段无配置时，视为「启用 + 使用原硬编码必填/标签」，
 *  保证既有表单在无配置或接口异常时与现状一致。
 */
export * from "./configurable-field/context";
export * from "./configurable-field/rules";
export * from "./configurable-field/items";
export * from "./configurable-field/custom-fields";
export * from "./configurable-field/display";
