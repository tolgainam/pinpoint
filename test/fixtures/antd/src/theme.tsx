import { ConfigProvider } from 'antd'

export const themeConfig = {
  token: { colorPrimary: '#1677ff', colorSuccess: '#52c41a', borderRadius: 6 },
}

export const Provider = ({ children }) => (
  <ConfigProvider theme={themeConfig}>{children}</ConfigProvider>
)
