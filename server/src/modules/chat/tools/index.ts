import { getCurrentTimeTool, getCurrentTimeHandler } from './get-current-time.tool'
import { getWeatherTool, getWeatherHandler } from './get-weather.tool'

// 工具定义：告诉大模型有哪些工具、每个工具是做什么的、需要什么参数
export const tools = [getCurrentTimeTool, getWeatherTool]

// 工具执行器：根据大模型返回的 tool_calls 在本地真正执行函数
// key 必须和工具定义里的 function.name 一致
export const toolHandlers: Record<string, (args:{location:string}) => Promise<any> | any> = {
  get_current_time: getCurrentTimeHandler,
  get_wather: getWeatherHandler
}

// 导出工具类型，方便 chat.service 里使用
export type ToolHandlerMap = typeof toolHandlers
