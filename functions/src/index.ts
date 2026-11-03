import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import * as QRCode from "qrcode";

// 1. Inicializar Firebase Admin con Application Default Credentials (ADC)
admin.initializeApp();
const db = admin.firestore();

// Tipos para la API de Telegram y Modelo de Datos
interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface WifiConfig {
  ssid: string;
  password: string;
  admins: number[];
}

/**
 * Escapa caracteres reservados dentro de bloques de código en Telegram MarkdownV2 (` y \).
 */
function escapeMarkdownV2Code(text: string): string {
  return text.replace(/([\\`])/g, "\\$1");
}

/**
 * Realiza una petición POST al endpoint sendMessage de la API de Telegram.
 */
async function sendTelegramMessage(
  chatId: number,
  text: string,
  parseMode?: string
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Variable de entorno TELEGRAM_BOT_TOKEN no configurada.");
    return;
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      `Error al enviar mensaje Telegram (${response.status}):`,
      errorBody
    );
  }
}

/**
 * Realiza una petición POST al endpoint sendPhoto de la API de Telegram enviando un Buffer en multipart/form-data.
 */
async function sendTelegramPhoto(
  chatId: number,
  photoBuffer: Buffer,
  caption: string,
  parseMode?: string
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Variable de entorno TELEGRAM_BOT_TOKEN no configurada.");
    return;
  }

  const formData = new FormData();
  formData.append("chat_id", String(chatId));

  const photoBlob = new Blob([new Uint8Array(photoBuffer)], {
    type: "image/png",
  });
  formData.append("photo", photoBlob, "wifi_qr.png");
  formData.append("caption", caption);

  if (parseMode) {
    formData.append("parse_mode", parseMode);
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendPhoto`,
    {
      method: "POST",
      body: formData,
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      `Error al enviar imagen Telegram (${response.status}):`,
      errorBody
    );
  }
}

/**
 * Cloud Function HTTP Webhook para Telegram.
 */
export const telegramWebhook = onRequest(
  {
    invoker: "public",
  },
  async (req, res): Promise<void> => {
    // Regla 2: Si el método no es POST, devolver HTTP 405
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const update = req.body as TelegramUpdate;
    const message = update?.message;

    // Regla 3: Si el body no contiene message.text, devolver HTTP 200 OK
    if (!message || typeof message.text !== "string") {
      res.status(200).send("OK");
      return;
    }

    const text = message.text.trim();
    const chatId = message.chat?.id;
    const fromId = message.from?.id;

    // Obtener y validar variables de entorno
    const allowedGroupIdStr = process.env.ALLOWED_GROUP_ID;
    if (!allowedGroupIdStr) {
      console.error(
        "Variable de entorno ALLOWED_GROUP_ID no está configurada."
      );
      res.status(200).send("OK");
      return;
    }

    const allowedGroupId = Number(allowedGroupIdStr);

    // =========================================================================
    // Caso 2: Actualización de Credenciales (Comando /setwifi)
    // =========================================================================
    if (text.startsWith("/setwifi")) {
      // Seguridad Nivel 1 (Grupo): Validar que message.chat.id sea igual a ALLOWED_GROUP_ID
      if (chatId !== allowedGroupId) {
        console.warn(
          `[Seguridad] Fallo Nivel 1: Intento no autorizado de /setwifi desde chat_id: ${chatId}. Esperado: ${allowedGroupId}`
        );
        res.status(200).send("OK");
        return;
      }

      try {
        const docRef = db.collection("configuracion").doc("wifi");
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
          console.warn("Documento configuracion/wifi no encontrado en Firestore.");
          await sendTelegramMessage(
            chatId,
            "⚠️ No se encontró la configuración WiFi en la base de datos."
          );
          res.status(200).send("OK");
          return;
        }

        const data = docSnap.data() as WifiConfig;
        const admins = Array.isArray(data.admins) ? data.admins : [];

        // Seguridad Nivel 2 (Usuario): Validar que message.from.id exista dentro de admins
        if (!fromId || !admins.includes(fromId)) {
          console.warn(
            `[Seguridad] Fallo Nivel 2: Usuario ${fromId} intentó ejecutar /setwifi sin privilegios de admin.`
          );
          await sendTelegramMessage(
            chatId,
            "⛔ No tienes permisos para modificar las credenciales WiFi."
          );
          res.status(200).send("OK");
          return;
        }

        // Flujo: Extraer la <nueva_clave> (sanitizar espacios)
        const match = text.match(/^\/setwifi(?:@\S+)?\s+(.+)$/s);
        const newPassword = match ? match[1].trim() : "";

        if (!newPassword) {
          await sendTelegramMessage(
            chatId,
            "⚠️ Formato incorrecto. Uso: /setwifi <nueva_clave>"
          );
          res.status(200).send("OK");
          return;
        }

        // Actualizar en Firestore
        await docRef.update({ password: newPassword });

        // Enviar confirmación al chat
        await sendTelegramMessage(
          chatId,
          "✅ Clave WiFi actualizada correctamente."
        );
      } catch (error) {
        console.error("Error al procesar /setwifi:", error);
      }

      res.status(200).send("OK");
      return;
    }

    // =========================================================================
    // Caso 1: Lectura de Credenciales (Comando /wifi)
    // =========================================================================
    if (text.startsWith("/wifi")) {
      // Seguridad: Validar que message.chat.id sea exactamente igual a ALLOWED_GROUP_ID
      if (chatId !== allowedGroupId) {
        console.warn(
          `[Seguridad] Intento no autorizado de /wifi desde chat_id: ${chatId}. Esperado: ${allowedGroupId}`
        );
        res.status(200).send("OK");
        return;
      }

      try {
        const docRef = db.collection("configuracion").doc("wifi");
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
          console.warn("Documento configuracion/wifi no encontrado en Firestore.");
          await sendTelegramMessage(
            chatId,
            "⚠️ No se encontró la configuración WiFi en la base de datos."
          );
          res.status(200).send("OK");
          return;
        }

        const data = docSnap.data() as WifiConfig;

        // Generar buffer QR con formato WiFi estándar
        const qrPayload = `WIFI:S:${data.ssid};T:WPA;P:${data.password};;`;
        const qrBuffer = await QRCode.toBuffer(qrPayload, {
          type: "png",
          errorCorrectionLevel: "M",
          margin: 2,
          width: 512,
        });

        // Construir caption en formato MarkdownV2
        const caption =
          `📶 *WiFi Oficina*\n` +
          `Red: \`${escapeMarkdownV2Code(data.ssid)}\`\n` +
          `Clave: \`${escapeMarkdownV2Code(data.password)}\``;

        // Enviar foto vía sendPhoto
        await sendTelegramPhoto(chatId, qrBuffer, caption, "MarkdownV2");
      } catch (error) {
        console.error("Error al procesar /wifi:", error);
      }

      res.status(200).send("OK");
      return;
    }

    // Cualquier otro mensaje que no sea /wifi o /setwifi
    res.status(200).send("OK");
  }
);

