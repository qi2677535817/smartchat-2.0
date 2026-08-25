export function saveMessage(list: Array<any>) {
    const newList = list.map(item => ({
        content: item.content,
        role: item.role,
        reasoning_content: item.reasoning_content,
    }))
    localStorage.setItem('chat_message', JSON.stringify(newList))
}

export function loadMessages() {
    try {
        let list = localStorage.getItem('chat_message')
        if (!list) {
            return []
        }
        return JSON.parse(list)
    } catch {
        return []
    }
}

export function loadSessions() {
    try {
        let sessions = localStorage.getItem('chat_message')
        if (!sessions) {
            return {}
        }
        return JSON.parse(sessions)
    } catch (e) {
        console.error(e)
        return {}
    }
}

export function saveSessions(data: {
    id?: string,
    message: Array<any>
}) {
    // 这里先获取本地的sessions
    let sessionsData: {
        activeId:string,
        sessions:{
            id: string,
            createdAt: number,
            title: string,
            message: Array<any>
        }[]
    } = loadSessions()
    if (!sessionsData) {
        // 创建sessions
        sessionsData = {
            sessions: [],
            activeId: ''
        }
    }
    let id = ''
    let obj = {
        id,
        message: data.message,
        title: data.message[0].content,
        createdAt: new Date().getDate()
    }
    // 校验id是否存在
    if (!data.id) {
        id = crypto.randomUUID()
        obj.id = id
        sessionsData.sessions.push(obj)
    }else {
        let index = sessionsData.sessions.findIndex(item => item.id == id)
        sessionsData.sessions[index]!.message = data.message
    }
    sessionsData.activeId = id
}