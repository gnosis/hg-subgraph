module.exports = {
  parser: '@typescript-eslint/parser',
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
    'prettier/@typescript-eslint'
  ],
  env: {
    node: false
  },
  globals: {
    module: true
  },
  rules: {
    '@typescript-eslint/no-unused-vars': 'error'
  }
};
