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
    }catch {
        return []
    }

}