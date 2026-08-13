// 工具定义
export const getCurrentTimeTool = {
    type: "function",
    function: {
        name: 'get_current_time',
        description:'获取当前的日期和时间。当用户询问"现在几点"、"今天几号"、"当前时间"等问题时使用。',
        parameters:{
            type: 'object',
            properties: {},
            required: []
        }
    }
}

// 工具实现：实际执行的函数
export const getCurrentTimeHandler = async () => {
    return new Date().toLocaleString('zh-CN', {
        hour12: false
    })
}