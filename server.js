require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// CONFIGURACIÓN DE BASE DE DATOS (SQLITE)
// ==========================================
const dbPath = path.resolve(__dirname, 'monedero.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error al abrir la base de datos SQLite:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite exitosamente.');
        db.run(`CREATE TABLE IF NOT EXISTS transacciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referencia TEXT,
            monto TEXT,
            telefonoEmisor TEXT,
            telefonoDestino TEXT,
            fechaHora TEXT
        )`);
    }
});

// ==========================================
// CONFIGURACIÓN DE RATE LIMITING (SEGURIDAD)
// ==========================================
const limiterPagos = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 5, // Máximo 5 intentos por IP en ese tiempo para pagos/códigos
    message: { 
        success: false, 
        message: 'Demasiadas solicitudes desde esta IP, por seguridad intente de nuevo más tarde.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100 // Límite general para otras peticiones
});

app.use(limiterGeneral);

// Servidor de archivos estáticos con ruta absoluta
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

// Helper para formatear número a formato internacional de WhatsApp
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

// Rutas de Páginas
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'authMovilUI.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(publicPath, 'pagoMovilUI.html'));
});

// Rutas de assets dinámicas
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
// APIs Y RUTAS DE TRANSACCIONES
// ==========================================

// Consultar Historial de Transacciones por Teléfono
app.get('/api/historial/:telefono', (req, res) => {
    const telefono = req.params.telefono;
    db.all(
        `SELECT * FROM transacciones WHERE telefonoEmisor = ? OR telefonoDestino = ? ORDER BY id DESC`,
        [telefono, telefono],
        (err, rows) => {
            if (err) {
                console.error("Error consultando historial:", err.message);
                return res.status(500).json({ success: false, message: 'Error al consultar historial en la base de datos' });
            }
            res.json({ success: true, historial: rows });
        }
    );
});

app.post('/api/enviar-codigo', limiterPagos, async (req, res) => {
    const { telefono } = req.body;
    try {
        const codigoVerificacion = Math.floor(100000 + Math.random() * 900000);
        let chatId = formatearNumeroWhatsapp(telefono);
        const mensaje = `Tu código de acceso a Monedero es: *${codigoVerificacion}*`;

        if (chatId) {
            await client.sendMessage(chatId, mensaje);
        }
        res.json({ success: true, message: '¡Código enviado con éxito por WhatsApp!', codigoMock: codigoVerificacion });
    } catch (error) {
        console.error("Error al enviar WhatsApp:", error);
        res.status(500).json({ success: false, message: 'Hubo un error al enviar el WhatsApp' });
    }
});

app.post('/api/registrar-metodos', (req, res) => {
    const { cedulaTitular, metodo, cuentaDestino } = req.body;
    console.log(`Método registrado exitosamente -> Cédula: ${cedulaTitular || 'N/D'}, Método: ${metodo || 'N/D'}, Cuenta: ${cuentaDestino || 'N/D'}`);
    res.json({ 
        success: true, 
        message: '¡Método vinculado de forma segura con éxito!' 
    });
});

app.post('/api/enviar-pago', limiterPagos, async (req, res) => {
    try {
        const monto = req.body.montoUSDT || req.body.monto || req.body.amount || req.body.cantidad || req.body.valor;
        
        // Teléfono del Destinatario (Comercio / Persona que recibe)
        const telefonoDestino = req.body.telefonoComercio || req.body.telefono || req.body.phone || req.body.nroTelefono;
        
        // Teléfono del Emisor (Pagador)
        const telefonoEmisor = req.body.telefonoEmisor || req.body.telefonoPagador || req.body.telefonoUsuario;

        const esComercio = req.body.esComercio || false; 
        
        if (!monto) {
            return res.status(400).json({ 
                success: false, 
                message: 'El monto es obligatorio para procesar el pago',
                recibido: req.body 
            });
        }

        // Generar Referencia Única de Transacción y Marca de Tiempo
        const numeroReferencia = 'REF-' + Math.floor(100000 + Math.random() * 900000);
        const ahora = new Date();
        const fechaHora = ahora.toLocaleString('es-VE', { timeZone: 'America/Caracas' });

        let comisionAplicada = 0;
        let destinoComision = '';

        if (esComercio) {
            comisionAplicada = calcularComisionComercio(monto);
            destinoComision = `Binance Wallet (${BINANCE_COMMISSION_WALLET})`;
        } else {
            comisionAplicada = COMISION_FIJA_USUARIO;
            destinoComision = `PayPal (${PAYPAL_RECEIVER_EMAIL})`;
        }

        // Guardar transacción en la base de datos SQLite de forma permanente
        db.run(
            `INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, fechaHora) VALUES (?, ?, ?, ?, ?)`,
            [numeroReferencia, monto, telefonoEmisor || 'N/D', telefonoDestino || 'N/D', fechaHora],
            (err) => {
                if (err) console.error("Error guardando transacción en DB:", err.message);
            }
        );

        // 1. Notificación al DESTINATARIO (Quien recibe el dinero)
        if (telefonoDestino) {
            try {
                let chatIdDestino = formatearNumeroWhatsapp(telefonoDestino);
                if (chatIdDestino) {
                    const mensajeDestino = `¡PAGO RECIBIDO! 🟢\n\n` +
                        `📌 *Referencia:* ${numeroReferencia}\n` +
                        `💵 *Monto:* $${monto} USDT\n` +
                        `📅 *Fecha y Hora:* ${fechaHora}\n\n` +
                        `Abono verificado y acreditado exitosamente.`;
                    await client.sendMessage(chatIdDestino, mensajeDestino);
                }
            } catch (wppError) {
                console.error('No se pudo enviar la notificación al destinatario:', wppError);
            }
        }

        // 2. Notificación al EMISOR (Quien envía el dinero)
        if (telefonoEmisor) {
            try {
                let chatIdEmisor = formatearNumeroWhatsapp(telefonoEmisor);
                if (chatIdEmisor) {
                    const mensajeEmisor = `¡PAGO ENVIADO! 🔴\n\n` +
                        `📌 *Referencia:* ${numeroReferencia}\n` +
                        `💵 *Monto:* $${monto} USDT\n` +
                        `📅 *Fecha y Hora:* ${fechaHora}\n` +
                        `👤 *Destinatario:* ${telefonoDestino || 'Registrado'}\n\n` +
                        `Operación procesada con éxito.`;
                    await client.sendMessage(chatIdEmisor, mensajeEmisor);
                }
            } catch (wppError) {
                console.error('No se pudo enviar la notificación al emisor:', wppError);
            }
        }

        res.json({ 
            success: true, 
            message: '¡Pago enviado, registrado y procesado con éxito!',
            referencia: numeroReferencia,
            fechaHora: fechaHora,
            montoProcesado: monto,
            comisionPlataforma: comisionAplicada,
            destinoComision: destinoComision,
            notificacionesEnviadas: {
                destinatario: !!telefonoDestino,
                emisor: !!telefonoEmisor
            }
        });

    } catch (error) {
        console.error('Error crítico al procesar el pago:', error);
        res.status(500).json({ success: false, message: 'Error interno al procesar el pago' });
    }
});

app.post('/api/paypal/crear-orden', async (req, res) => {
    try {
        const { amount } = req.body;
        const monto = amount || "10.00";

        if (parseFloat(monto) < MIN_DEPOSITO) {
            return res.status(400).json({ success: false, message: `El depósito mínimo es de $${MIN_DEPOSITO}` });
        }

        const comisionPayPal = Number((monto * 0.054 + 0.30).toFixed(2));
        const montoTotalConComision = Number((parseFloat(monto) + comisionPayPal + COMISION_FIJA_USUARIO).toFixed(2));
        const accessToken = await getPayPalAccessToken();

        const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: {
                        currency_code: 'USD',
                        value: montoTotalConComision.toString(),
                        breakdown: {
                            item_total: { currency_code: 'USD', value: parseFloat(monto).toFixed(2) },
                            handling: { currency_code: 'USD', value: (comisionPayPal + COMISION_FIJA_USUARIO).toString() }
                        }
                    },
                    description: 'Recarga / Pago en plataforma Monedero (Destino: ' + PAYPAL_RECEIVER_EMAIL + ')'
                }]
            })
        });

        const orderData = await response.json();
        if (orderData.id) {
            res.json({ 
                success: true, 
                id: orderData.id, 
                montoBase: monto,
                comision: comisionPayPal,
                gananciaPlataforma: COMISION_FIJA_USUARIO,
                total: montoTotalConComision,
                receptorPayPal: PAYPAL_RECEIVER_EMAIL
            });
        } else {
            res.status(500).json({ success: false, message: 'No se pudo crear la orden en PayPal', details: orderData });
        }
    } catch (error) {
        console.error('Error creando orden de PayPal:', error);
        res.status(500).json({ success: false, message: 'Error interno al procesar PayPal' });
    }
});

app.post('/api/paypal/capturar-orden', async (req, res) => {
    try {
        const { orderID } = req.body;
        const accessToken = await getPayPalAccessToken();

        const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderID}/capture`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        const captureData = await response.json();
        if (captureData.status === 'COMPLETED') {
            res.json({ success: true, message: '¡Pago con PayPal capturado con éxito!', data: captureData });
        } else {
            res.status(400).json({ success: false, message: 'El pago no se pudo completar', details: captureData });
        }
    } catch (error) {
        console.error('Error capturando orden de PayPal:', error);
        res.status(500).json({ success: false, message: 'Error interno al capturar la orden' });
    }
});

app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});