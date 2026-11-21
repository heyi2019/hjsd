/** 建单表单字段配置驱动：拉取某业务类型的 OrderFormField 配置，并提供
 *  - FieldConfigContext / useFieldConfig：CreateBusinessModal 把配置注入此 context，各 Section 默认从此读取
 *  - CfgItem：受配置驱动的 Form.Item（停用字段不渲染、必填/标签从配置读）
 *  - CfgNestedItem：同上，但渲染在 BusinessRegistrationField 布局内（name 在内层 Form.Item）
 *  - CustomFormField：渲染用户自定义字段（值归集到 form_extra.<field_key>）
 *  配置加载失败时提示重试并阻止表单提交；已加载配置中未定义的字段沿用默认规则。
 */
export * from "./configurable-field/context";
export * from "./configurable-field/rules";
export * from "./configurable-field/items";
export * from "./configurable-field/custom-fields";
export * from "./configurable-field/display";
