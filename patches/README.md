# Dependency patches

`rc-field-form+2.7.1.patch` backports the upstream fix for a false circular-reference warning when form field metadata is updated: https://github.com/react-component/field-form/pull/650. Remove the patch when the installed form dependency includes that fix, and keep the form regression test passing.
