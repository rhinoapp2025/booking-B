-- รันใน pgAdmin บน database nail_booking (ถ้า backend ยังไม่สร้างตารางให้)
-- โดยปกติ backend จะสร้างตารางอัตโนมัติตอน start ผ่าน ensureSchema.js

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ดูรายละเอียดเต็มใน src/db/ensureSchema.js
