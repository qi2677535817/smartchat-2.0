export const getWeatherTool = {
    type: 'function',
    function: {
        name:'get_wather',
        description: '获取指定城市的当前天气...',
        parameters: {
            type: 'object',
            properties: {
                location: {
                    type: 'string',
                    description: '城市名称, 如北京、上海',
                }
            },
            required: ['location']
        }
    }
}

export const getWeatherHandler = async (args: { location: string }) => {
    // args 已经是你 parse 之后的对象
    return `${args.location} 今天晴，25度，适合出门`
}