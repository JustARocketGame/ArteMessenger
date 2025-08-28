import sqlite3

def clear_db():
    conn = sqlite3.connect('database.db')
    c = conn.cursor()
    
    # Удаляем все записи из таблиц
    #c.execute("DELETE FROM users;")
    #c.execute("DELETE FROM messages;")
    
    # Сбрасываем автоинкрементные счетчики
    #c.execute("DELETE FROM sqlite_sequence WHERE name IN ('users','messages');")
    c.execute("DROP TABLE IF EXISTS messages;")
    
    conn.commit()
    conn.close()
    print("База данных успешно очищена!")

if __name__ == "__main__":
    clear_db()
