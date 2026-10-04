/**
 * 标书需求条目提交工具（提取专用）
 *
 * 仅由 tender 提取流程在调用 FC 循环时显式传入，不注册到全局 tools 数组
 * （避免普通对话场景中模型误调用）。
 * handler 采用工厂模式：闭包收集本块提取到的条目，跨块由调用方累积。
 */

// 提取条目结构（与 review-tool-spec 第四节的 items 字段对齐）
export type RequirementItem = {
    cat: string
    name: string
    quote: string
    origin: string
    level: string
    form: string
    anchor: string
}

export const submitRequirementsTool = {
    type: 'function',
    function: {
        name: 'submit_requirements',
        description:
            '提交从招标文件中提取的需求条目清单。每条必须包含招标文件原文逐字引用与定位锚点；' +
            '找不到原文依据的内容禁止提交。禁止输出任何页码数字，页码由系统本地计算。',
        parameters: {
            type: 'object',
            properties: {
                items: {
                    type: 'array',
                    description: '从本段招标文件中提取到的需求条目数组',
                    items: {
                        type: 'object',
                        properties: {
                            cat: {
                                type: 'string',
                                description:
                                    '分类，从下列七类中选择其一：A 资格证明文件 / B 投标保证金 / ' +
                                    'C 投标文件格式文件 / D 声明与承诺函件 / E 技术响应文件 / ' +
                                    'F 业绩与信誉材料 / G 商务与其他',
                            },
                            name: {
                                type: 'string',
                                description: '材料或资质名称，用招标文件原文命名，不得改写简称',
                            },
                            quote: {
                                type: 'string',
                                description: '逐字摘录的要求原文，限定词（份数/年份/盖章等）一个都不能丢',
                            },
                            origin: {
                                type: 'string',
                                description: '出处章节名（如「第四章 资格审查办法前附表」），禁止写页码',
                            },
                            level: {
                                type: 'string',
                                enum: ['强制', '评分', '待确认'],
                                description: '强制级别：不提供即无效→强制；影响得分→评分；表述模糊→待确认',
                            },
                            form: {
                                type: 'string',
                                description: '形式要求：正副本份数/盖章签字/原件或复印件/电子件/有效期等',
                            },
                            anchor: {
                                type: 'string',
                                description: '短（10-30 字）、唯一、不跨页的原文连续片段，用于坐标定位',
                            },
                        },
                        required: ['cat', 'name', 'quote', 'origin', 'level', 'form', 'anchor'],
                    },
                },
            },
            required: ['items'],
        },
    },
}

// handler 工厂：collect 回调由调用方提供，用于累积条目
export const createSubmitRequirementsHandler =
    (collect: (items: RequirementItem[]) => void) =>
        async (args: { items?: RequirementItem[] }) => {
            const items = Array.isArray(args?.items) ? args.items : []
            collect(items)
            return { received: items.length }
        }
