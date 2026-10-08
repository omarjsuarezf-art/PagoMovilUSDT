// Módulo de Autenticación por WhatsApp (OTP)
const crypto = require('crypto');
const express = require('express');
const router = express.Router();

// Simulación de una base de datos temporal para guardar códigos activos
const codigosVerificacion = new Map();

async function solicitarCodigoWhatsApp(req, res) {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: "El número de teléfono es obligatorio." });
    }

    // 1. Generar un código aleatorio de 6 dígitos
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Guardar el código con un tiempo de expiración (ej. 5 minutos)
    codigosVerificacion.set(phoneNumber, {
        code: otpCode,
        expiresAt: Date.now() + 5 * 60 * 1000 
    });

    try {
        // 2. Aquí integrarías la API de WhatsApp (ej. Twilio, Meta Cloud API o Evolution API)
        console.log(`Enviando WhatsApp al ${phoneNumber}: Tu código de acceso es ${otpCode}`);
        
        // Simulación de respuesta exitosa
        return res.json({ 
            success: true, 
            message: "Código de verificación enviado con éxito a tu WhatsApp." 
        });

    } catch (error) {
        return res.status(500).json({ success: false, error: "No se pudo enviar el mensaje por WhatsApp." });
    }
}

// Ruta POST para solicitar el código
router.post('/solicitar', solicitarCodigoWhatsApp);

// ¡ESTA ES LA LÍNEA QUE FALTABA! Exportar el router para Express
module.exports = router;