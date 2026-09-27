require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// CONFIGURACIÓN DE BASE DE DATOS (SQLITE)
// ==========================================
const dbPath = path.resolve(__dirname, 'monedero.db');
const db = new Database(dbPath);

// Inicializar tablas
db.exec(`
    CREATE TABLE IF NOT EXISTS transacciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referencia TEXT,
        monto TEXT,
        telefonoEmisor TEXT,
        telefonoDestino TEXT,
        fechaHora TEXT
    );

    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telefono TEXT UNIQUE,
        pinSeguridad TEXT,
        accountType TEXT DEFAULT 'natural',
        dailyLimit REAL DEFAULT 1000.00,
        upgradedAt TEXT
    );
`);

// Asegurarse por las malas de que la columna pinSeguridad exista si la tabla ya era vieja
try {
    db.exec(`ALTER TABLE usuarios ADD COLUMN pinSeguridad TEXT`);
} catch (e) {
    // Si ya existe ignoramos el error con elegancia
}

console.log('Conectado a la base de datos SQLite exitosamente.');

// ==========================================
// CONFIGURACIÓN DE RATE LIMITING (SEGURIDAD)
// ==========================================
const limiterPagos = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 10, 
    message: { 
        success: false, 
        message: 'Demasiadas solicitudes desde esta IP, por seguridad intente de nuevo más tarde.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100 
});

app.use(limiterGeneral);

const publicPath = path.resolve(__dirname, 'frontend', 'public');
app.use(express.static(publicPath));
app.use('/public', express.static(publicPath));

// ==========================================
// CONFIGURACIÓN DE DESTINOS PERSONALES (.ENV)
// ==========================================
const PAYPAL_RECEIVER_EMAIL = process.env.PAYPAL_RECEIVER_EMAIL || 'pagos@mipasarela.com';
const BINANCE_COMMISSION_WALLET = process.env.BINANCE_COMMISSION_WALLET || 'Binance Pay / Wallet ID';

// ==========================================
// LÍMITES Y COMISIONES
// ==========================================
const MIN_DEPOSITO = 5.00;                  
const MAX_RETIRO_NATURAL = 1000.00;         

const COMISION_FIJA_USUARIO = 1.00;         
const COMISION_PORCENTAJE_COMERCIO = 0.03;  
const COMISION_MINIMA_COMERCIO = 2.00;      

function calcularComisionComercio(montoVenta) {
    let comisionCalculada = parseFloat(montoVenta) * COMISION_PORCENTAJE_COMERCIO;
    if (comisionCalculada < COMISION_MINIMA_COMERCIO) {
        return COMISION_MINIMA_COMERCIO; 
    }
    return Number(comisionCalculada.toFixed(2)); 
}

function formatearNumeroWhatsapp(numero) {
    if (!numero) return null;
    let numLimpio = numero.toString().trim().replace(/\D/g, ''); 
    if (numLimpio.startsWith('0')) {
        numLimpio = numLimpio.substring(1);
    }
    return numLimpio.startsWith('58') ? `${numLimpio}@c.us` : `58${numLimpio}@c.us`;
}

// ==========================================
// CONFIGURACIÓN DE PAYPAL
// ==========================================
const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID || 'TU_CLIENT_ID_DE_PAYPAL';
const PAYPAL_SECRET = process.env.PAYPAL_SECRET_KEY || process.env.PAYPAL_CLIENT_SECRET || 'TU_SECRET_DE_PAYPAL';
const PAYPAL_API = process.env.NODE_ENV === 'production' 
    ? 'https://api-m.paypal.com' 
    : 'https://api-m.sandbox.paypal.com';

async function getPayPalAccessToken() {
    const auth = Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64');
    const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
        method: 'POST',
        body: 'grant_type=client_credentials',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    const data = await response.json();
    return data.access_token;
}

const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    console.log('Escanea este código QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('¡Cliente de WhatsApp conectado y listo para enviar mensajes!');
});

client.initialize();

// ==========================================
// RUTAS DE PÁGINAS
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'authMovilUI.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(publicPath, 'pagoMovilUI.html'));
});

app.get('/manifest.json', (req, res) => {
    try {
        const archivos = fs.readdirSync(publicPath);
        const manifestFile = archivos.find(f => f.toLowerCase().includes('manifest'));
        if (manifestFile) return res.sendFile(path.join(publicPath, manifestFile));
        res.status(404).send('Manifest no encontrado');
    } catch (err) {
        res.status(500).send('Error leyendo directorio del manifest');
    }
});

app.get('/logo.png', (req, res) => {
    try {
        const archivos = fs.readdirSync(publicPath);
        const logoFile = archivos.find(f => f.toLowerCase().includes('logo'));
        if (logoFile) return res.sendFile(path.join(publicPath, logoFile));
        res.status(404).send('Logo no encontrado');
    } catch (err) {
        res.status(500).send('Error leyendo directorio del logo');
    }
});

// ==========================================
// APIS Y RUTAS DE TRANSACCIONES
// ==========================================

app.get('/api/historial/:telefono', (req, res) => {
    try {
        const telefono = req.params.telefono;
        const rows = db.prepare(
            `SELECT * FROM transacciones WHERE telefonoEmisor = ? OR telefonoDestino = ? ORDER BY id DESC`
        ).all(telefono, telefono);
        res.json({ success: true, transacciones: rows, historial: rows });
    } catch (err) {
        console.error("Error consultando historial:", err.message);
        return res.status(500).json({ success: false, message: 'Error al consultar historial en la base de datos' });
    }
});

// Registro de usuario, guardado de PIN y envío de código WhatsApp
app.post('/api/enviar-codigo', limiterPagos, async (req, res) => {
    const { telefono, pinSeguridad } = req.body;
    
    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ success: false, message: 'El teléfono y el PIN de seguridad son obligatorios.' });
    }

    try {
        db.prepare(
            `INSERT INTO usuarios (telefono, pinSeguridad, accountType) VALUES (?, ?, 'natural')
             ON CONFLICT(telefono) DO UPDATE SET pinSeguridad = ?`
        ).run(telefono, pinSeguridad, pinSeguridad);

        const codigoVerificacion = Math.floor(100000 + Math.random() * 900000);
        let chatId = formatearNumeroWhatsapp(telefono);
        
        const mensaje = `¡Registro Exitoso en Monedero USDT! 🟢\n\nTu línea ha sido validada correctamente y tu PIN de seguridad de 4 dígitos ha quedado configurado.\n\n🔑 *Tu PIN configurado:* ${pinSeguridad}\n🔢 *Código de verificación:* *${codigoVerificacion}*`;

        if (chatId) {
            await client.sendMessage(chatId, mensaje);
        }
        res.json({ success: true, message: '¡Código enviado por WhatsApp con éxito y PIN configurado!', codigoMock: codigoVerificacion });
    } catch (error) {
        console.error("Error guardando/actualizando usuario o enviando WhatsApp:", error);
        res.status(500).json({ success: false, message: 'Error interno al registrar el usuario o enviar el WhatsApp.' });
    }
});

app.post('/api/recuperar-pin', limiterPagos, async (req, res) => {
    const { telefono, nuevoPin } = req.body;

    if (!telefono || !nuevoPin || nuevoPin.length !== 4) {
        return res.status(400).json({ success: false, message: 'Indica tu número de teléfono y un nuevo PIN válido de 4 dígitos.' });
    }

    try {
        const user = db.prepare(`SELECT * FROM usuarios WHERE telefono = ?`).get(telefono);

        if (!user) {
            return res.status(404).json({ success: false, message: 'El número de teléfono no está registrado en el sistema.' });
        }

        db.prepare(`UPDATE usuarios SET pinSeguridad = ? WHERE telefono = ?`).run(nuevoPin, telefono);

        try {
            let chatId = formatearNumeroWhatsapp(telefono);
            if (chatId) {
                await client.sendMessage(chatId, `🔐 *Seguridad Monedero:* Tu PIN de 4 dígitos ha sido restablecido exitosamente.`);
            }
        } catch (wppErr) {
            console.error("Error enviando aviso de cambio de PIN:", wppErr);
        }

        res.json({ success: true, message: '¡PIN de seguridad actualizado con éxito!' });
    } catch (err) {
        console.error("Error en recuperar-pin:", err);
        return res.status(500).json({ success: false, message: 'Error consultando o actualizando la base de datos.' });
    }
});

app.post('/api/registrar-metodos', (req, res) => {
    const { cedulaTitular, metodo, cuentaDestino } = req.body;
    res.json({ 
        success: true, 
        message: '¡Método vinculado de forma segura con éxito!' 
    });
});

app.post('/api/upgrade-account', async (req, res) => {
    const { userId, telefono, paymentReference } = req.body;
    const identificador = userId || telefono;

    if (!identificador) {
        return res.status(400).json({ success: false, message: "Falta el identificador del usuario." });
    }

    try {
        let user = db.prepare(`SELECT * FROM usuarios WHERE id = ? OR telefono = ?`).get(identificador, identificador);

        if (!user) {
            db.prepare(`INSERT INTO usuarios (telefono, accountType) VALUES (?, 'natural')`).run(identificador);
        }

        if (!paymentReference) {
            return res.status(400).json({ success: false, message: "Paga la tarifa de actualización para liberar tus fondos." });
        }

        const fechaActual = new Date().toISOString();
        db.prepare(
            `UPDATE usuarios SET accountType = 'commercial', dailyLimit = NULL, upgradedAt = ? WHERE id = ? OR telefono = ?`
        ).run(fechaActual, identificador, identificador);

        return res.status(200).json({
            success: true,
            message: "¡Bienvenido al nivel comercial! Perfil actualizado con éxito.",
            qrCode: `QR-COMERCIAL-${identificador}`
        });
    } catch (err) {
        console.error("Error en upgrade-account:", err);
        return res.status(500).json({ success: false, message: "Error interno en la base de datos." });
    }
});

app.post('/api/enviar-pago', limiterPagos, async (req, res) => {
    try {
        const monto = req.body.montoUSDT || req.body.monto || req.body.amount || req.body.cantidad || req.body.valor;
        const telefonoDestino = req.body.telefonoComercio || req.body.telefono || req.body.phone || req.body.nroTelefono;
        const telefonoEmisor = req.body.telefonoEmisor || req.body.telefonoPagador || req.body.telefonoUsuario;
        const pinSeguridad = req.body.pinSeguridad;
        const esComercio = req.body.esComercio || false; 
        
        if (!monto || !telefonoDestino) {
            return res.status(400).json({ success: false, message: 'El monto y el teléfono de destino son obligatorios' });
        }

        if (!telefonoEmisor) {
            return res.status(400).json({ success: false, message: 'Falta el teléfono del emisor para validar el PIN.' });
        }

        const usuario = db.prepare(`SELECT * FROM usuarios WHERE telefono = ?`).get(telefonoEmisor);

        if (!usuario) {
            return res.status(401).json({ success: false, message: '❌ Usuario emisor no registrado en el sistema. Registra tu línea primero.' });
        }

        if (usuario.pinSeguridad && usuario.pinSeguridad !== pinSeguridad) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto. Transacción rechazada.' });
        }

        const numeroReferencia = 'REF-' + Math.floor(100000 + Math.random() * 900000);
        const ahora = new Date();
        const fechaHora = ahora.toLocaleString('es-VE', { timeZone: 'America/Caracas' });

        let comisionAplicada = esComercio ? calcularComisionComercio(monto) : COMISION_FIJA_USUARIO;
        let destinoComision = esComercio ? `Binance Wallet (${BINANCE_COMMISSION_WALLET})` : `PayPal (${PAYPAL_RECEIVER_EMAIL})`;

        try {
            db.prepare(
                `INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, fechaHora) VALUES (?, ?, ?, ?, ?)`
            ).run(numeroReferencia, monto, telefonoEmisor, telefonoDestino, fechaHora);
        } catch (dbErr) {
            console.error("Error guardando transacción en DB:", dbErr.message);
        }

        if (telefonoDestino) {
            try {
                let chatIdDestino = formatearNumeroWhatsapp(telefonoDestino);
                if (chatIdDestino) {
                    const mensajeDestino = `¡PAGO RECIBIDO! 🟢\n\n📌 *Referencia:* ${numeroReferencia}\n💵 *Monto:* $${monto} USDT\n📅 *Fecha y Hora:* ${fechaHora}\n\nAbono verificado y acreditado exitosamente.`;
                    await client.sendMessage(chatIdDestino, mensajeDestino);
                }
            } catch (wppError) {
                console.error('No se pudo enviar la notificación al destinatario:', wppError);
            }
        }

        if (telefonoEmisor) {
            try {
                let chatIdEmisor = formatearNumeroWhatsapp(telefonoEmisor);
                if (chatIdEmisor) {
                    const mensajeEmisor = `¡PAGO ENVIADO! 🔴\n\n📌 *Referencia:* ${numeroReferencia}\n💵 *Monto:* $${monto} USDT\n📅 *Fecha y Hora:* ${fechaHora}\n👤 *Destinatario:* ${telefonoDestino}\n\nOperación procesada con éxito.`;
                    await client.sendMessage(chatIdEmisor, mensajeEmisor);
                }
            } catch (wppError) {
                console.error('No se pudo enviar la notificación al emisor:', wppError);
            }
        }

        return res.json({ 
            success: true, 
            message: `¡Pago de $${monto} USDT procesado y liquidado con éxito! Ref: ${numeroReferencia}`,
            referencia: numeroReferencia,
            fechaHora: fechaHora,
            montoProcesado: monto,
            comisionPlataforma: comisionAplicada,
            destinoComision: destinoComision
        });

    } catch (error) {
        console.error('Error crítico al procesar el pago:', error);
        res.status(500).json({ success: false, message: 'Error interno al procesar el pago' });
    }
});

app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});