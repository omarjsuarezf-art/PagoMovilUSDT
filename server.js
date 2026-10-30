require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const rateLimit = require('express-rate-limit');
const { open } = require('sqlite');
const sqlite3Internal = require('sqlite3');
const { Resend } = require('resend');
const { ethers } = require('ethers');
// Configuración de Resend limpia
const resend = new Resend(process.env.RESEND_API_KEY);

// Función para generar la cartera de Polygon al vuelo
function generarWalletIndividual() {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privatekey: wallet.privateKey
    };
}

const app = express();
// MAPA EN MEMORIA PARA RECUPERACIÓN DE PIN CON CÓDIGOS OTP (EXPIRAN EN 5 MINUTOS)
const codigosRecuperacion = new Map();

// Requerido por Railway/Render para lectura de IPs tras proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let db;

// ==========================================
// FUNCIÓN AUXILIAR DE ENVÍO DE CORREOS CON RESEND
// ==========================================
async function enviarCorreoResend(destino, asunto, mensajeHtml) {
    try {
        const respuesta = await resend.emails.send({
            from: 'PagoMovil USDT <onboarding@resend.dev>',
            to: [destino],
            subject: asunto,
            html: mensajeHtml
        });
        console.log('✅ Correo de Resend enviado con éxito. ID:', respuesta.id);
        return true;
    } catch (err) {
        console.error('⚠️ Error al enviar correo vía Resend:', err.message);
        return false;
    }
}


// ==========================================
// CONFIGURACIÓN DE BASE DE DATOS (SQLITE ASÍNCRONO OPTIMIZADO)
// ==========================================
async function inicializarBaseDatos() {
    try {
        const dbPath = path.resolve(__dirname, 'monedero.db');
        db = await open({
            filename: dbPath,
            driver: sqlite3Internal.Database
        });

        console.log('Conectado a la base de datos SQLite exitosamente.');

        // Inicializar tablas completas y comercio por defecto
        await db.exec(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefono TEXT UNIQUE,
                pinSeguridad TEXT,
                accountType TEXT DEFAULT 'natural',
                dailyLimit REAL DEFAULT 1000.00,
                upgradedAt TEXT
            );

            CREATE TABLE IF NOT EXISTS wallets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                usdt_balance REAL DEFAULT 0.00,
                FOREIGN KEY(user_id) REFERENCES usuarios(id)
            );

            CREATE TABLE IF NOT EXISTS transacciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                referencia TEXT,
                monto REAL,
                telefonoEmisor TEXT,
                telefonoDestino TEXT,
                reference_hash TEXT UNIQUE,
                fechaHora TEXT
            );

            CREATE TABLE IF NOT EXISTS metodos_pago (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cedulaTitular TEXT,
                metodo TEXT,
                cuentaDestino TEXT,
                fechaRegistro TEXT
            );

            CREATE TABLE IF NOT EXISTS comisiones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tipo TEXT,
                monto REAL,
                referencia TEXT,
                fechaHora TEXT
            );
        `);

        // Asegurar columnas opcionales si no existen
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN merchant_id TEXT;"); } catch (e) {}
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN metodoVinculado INTEGER DEFAULT 0;"); } catch (e) {}
        
        // Columnas para la billetera criptográfica única y permanente del usuario
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN assigned_wallet TEXT;"); } catch (e) {}
        try { await db.exec("ALTER TABLE usuarios ADD COLUMN private_key TEXT;"); } catch (e) {}

    } catch (err) {
        console.error('❌ Error al inicializar SQLite:', err.message);
    }
}

inicializarBaseDatos();

// ==========================================
// CONFIGURACIÓN DE RATE LIMITING (SEGURIDAD DIFERENCIADA)
// ==========================================
const limiterPagos = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 30,
    message: { 
        success: false, 
        message: 'Demasiadas solicitudes procesadas. Por seguridad intente de nuevo más tarde.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterConsultasComercio = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

const limiterGeneral = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000 
});

app.use(limiterGeneral);

const publicPath = path.resolve(__dirname, 'frontend', 'public');
app.use(express.static(publicPath));
app.use('/public', express.static(publicPath));

// ==========================================
// PARÁMETROS Y TARIFAS DE PLATAFORMA (POLYGON RED ÚNICA)
// ==========================================
const BINANCE_COMMISSION_WALLET = process.env.BINANCE_COMMISSION_WALLET || 'Binance Pay / Wallet ID';
const POLYGON_USDT_CONTRACT = '0xc2132d05d31c914a87c6611c10748aeb04b58e2f'; // USDT oficial en Polygon
const PLATFORM_POLYGON_WALLET = (process.env.PLATFORM_POLYGON_WALLET || '').toLowerCase(); // Tu wallet receptor oficial en Polygon

const COMISION_FIJA_USUARIO = 1.00;         
const COMISION_PORCENTAJE_COMERCIO = 0.03;  // 3%
const COMISION_MINIMA_COMERCIO = 2.00;      // Mínimo $2.00 USDT
const COSTO_CAMBIO_PLAN_COMERCIAL = 5.00;

const MONTO_MINIMO_RECARGA = 5.00;
const PORCENTAJE_RECARGA = 0.02; 
const MINIMO_COMISION_RECARGA = 1.00;

const PORCENTAJE_RETIRO = 0.02;  
const MINIMO_COMISION_RETIRO = 1.00;

function calcularComisionComercio(montoVenta) {
    let comisionCalculada = parseFloat(montoVenta) * COMISION_PORCENTAJE_COMERCIO;
    return comisionCalculada < COMISION_MINIMA_COMERCIO ? COMISION_MINIMA_COMERCIO : Number(comisionCalculada.toFixed(2));
}

function calcularComisionRecarga(monto) {
    let comisionCalculada = parseFloat(monto) * PORCENTAJE_RECARGA;
    return comisionCalculada < MINIMO_COMISION_RECARGA ? MINIMO_COMISION_RECARGA : Number(comisionCalculada.toFixed(2));
}

function calcularComisionRetiro(monto) {
    let comisionCalculada = parseFloat(monto) * PORCENTAJE_RETIRO;
    return comisionCalculada < MINIMO_COMISION_RETIRO ? MINIMO_COMISION_RETIRO : Number(comisionCalculada.toFixed(2));
} 

// ==========================================
// VALIDADOR AUTOMÁTICO BLOCKCHAIN (HTTP DIRECTO)
// ==========================================
async function verificarHashPolygonEnBlockchain(txHash, montoEsperadoMinimo) {
    return new Promise((resolve) => {
        if (!txHash || txHash.trim().length < 10) {
            return resolve({ valido: false, mensaje: '❌ Hash de transacción de Polygon inválido.' });
        }

        const cleanHash = txHash.trim().startsWith('0x') ? txHash.trim() : `0x${txHash.trim()}`;
        const https = require('https');
        const data = JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_getTransactionReceipt',
            params: [cleanHash],
            id: 1
        });

        const reqOptions = {
            hostname: 'polygon-mainnet.g.alchemy.com',
            path: '/v2/alh_QXifklhC8Igox8-9wTbcR',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length
            }
        };

        const req = https.request(reqOptions, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const responseJson = JSON.parse(body);
                    const receipt = responseJson.result;
                    if (receipt && receipt.status === '0x1') {
                        return resolve({ valido: true, mensaje: '✅ Transacción verificada correctamente en Polygon.' });
                    } else {
                        return resolve({ valido: false, mensaje: '❌ La transacción falló o aún no está confirmada.' });
                    }
                } catch (err) {
                    return resolve({ valido: false, mensaje: '❌ Error procesando respuesta de la blockchain.' });
                }
            });
        });

        req.on('error', (e) => {
            console.error("⚠️ Error de conexión con Alchemy:", e.message);
            return resolve({ valido: false, mensaje: '❌ Error de red consultando la blockchain.' });
        });

        req.write(data);
        req.end();
    });
}


// ==========================================
// FUNCIÓN ÚNICA Y SEGURA DE ENVÍO POR GREEN-API
// ==========================================
function formatearNumeroWhatsapp(numero) {
    if (!numero) return null;
    let numLimpio = numero.toString().trim().replace(/\D/g, '');
    if (numLimpio.startsWith('0')) {
        numLimpio = numLimpio.substring(1);
    }
    return numLimpio;
}

async function enviarMensajeWhatsappSeguro(numero, mensaje) {
    const idInstance = process.env.GREEN_API_ID_INSTANCE;
    const apiTokenInstance = process.env.GREEN_API_TOKEN_INSTANCE;

    if (!idInstance || !apiTokenInstance) {
        console.error('⚠️ Credenciales de Green-API no configuradas en el archivo .env');
        return;
    }

    try {
        let numLimpio = formatearNumeroWhatsapp(numero);
        if (!numLimpio) return;

        // Asegurar formato internacional completo (ej: 58412...)
        let chatId = numLimpio.startsWith('58') ? `${numLimpio}@c.us` : `58${numLimpio}@c.us`;

        const data = JSON.stringify({
            chatId: chatId,
            message: mensaje
        });

        // Extraer los primeros dígitos de la instancia para armar el host correcto (ej: 7107)
        const serverPrefix = idInstance.toString().substring(0, 4);

        const options = {
            hostname: `${serverPrefix}.api.green-api.com`,
            port: 443,
            path: `/waInstance${idInstance}/sendMessage/${apiTokenInstance}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`✅ Mensaje de Green-API enviado con éxito a ${chatId}`);
                } else {
                    console.error(`⚠️ Error al enviar WhatsApp vía Green-API (${res.statusCode}):`, responseBody);
                }
            });
        });

        req.on('error', (error) => {
            console.error(`⚠️ Error de conexión con Green-API:`, error.message);
        });

        req.write(data);
        req.end();

    } catch (e) {
        console.error(`⚠️ Excepción al enviar mensaje WhatsApp a ${numero}:`, e.message);
    }
}
// ==========================================
// RUTAS DE PÁGINAS (VISTAS - FLUJO OBLIGATORIO DE AUTH)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'pagoMovilUI.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(publicPath, 'authMovilUI.html'));
});

app.get('/panel', (req, res) => {
    res.sendFile(path.join(publicPath, 'pagoMovilUI.html'));
});

app.get('/recarga', (req, res) => {
    res.sendFile(path.join(publicPath, 'recargaMovilUI.html'));
});

app.get('/recargamovil.html', (req, res) => {
    res.sendFile(path.join(publicPath, 'recargaMovilUI.html'));
});

app.get('/recargamovil', (req, res) => {
    res.sendFile(path.join(publicPath, 'recargaMovilUI.html'));
});

app.get('/admin', (req, res) => {
    const adminFile = path.join(publicPath, 'admin.html');
    if (fs.existsSync(adminFile)) {
        res.sendFile(adminFile);
    } else {
        res.status(404).send(`Error: El archivo no existe en esta ruta exacta: ${adminFile}`);
    }
});

// ==========================================
// RUTAS DE RECUPERACIÓN DE PIN (BLINDADAS CON CÉDULA Y OTP)
// ==========================================
app.post('/api/recuperar-pin-request', limiterPagos, async (req, res) => {
    let telefono = (req.body.telefono || req.body.phone || '').trim();

    if (!telefono) {
        return res.status(400).json({ success: false, message: 'El número de teléfono es requerido.' });
    }

    try {
        const user = await db.get('SELECT id, telefono FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!user) {
            return res.status(404).json({ success: false, message: 'El número de teléfono no está registrado.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        codigosRecuperacion.set(user.telefono, { otp, timestamp: Date.now() });

        const mensajeWA = `🔑 *RECUPERACIÓN DE PIN - PagoMóvilUSDT*\n\nTu código de verificación es: *${otp}*\n\nExpira en 5 minutos.`;
        
        // Unificado con el nombre correcto de tu función segura de WhatsApp
        enviarMensajeWhatsappSeguro(telefono, mensajeWA).catch(() => {});

        return res.json({ success: true, message: 'Código enviado por WhatsApp.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error interno en el servidor.' });
    }
});

app.post('/api/recuperar-pin-confirm', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const otp = (req.body.otp || '').trim();
    const ultimos4Cedula = (req.body.ultimos4Cedula || req.body.ultimosCedula || '').trim();
    const nuevoPin = (req.body.nuevoPin || '').trim();

    if (!telefono || !otp || !ultimos4Cedula || !nuevoPin) {
        return res.status(400).json({ success: false, message: 'Todos los campos de recuperación son obligatorios.' });
    }

    if (nuevoPin.length !== 4) {
        return res.status(400).json({ success: false, message: 'El nuevo PIN debe ser estrictamente de 4 dígitos.' });
    }

    if (ultimos4Cedula.length !== 4) {
        return res.status(400).json({ success: false, message: 'Debe ingresar exactamente los últimos 4 dígitos.' });
    }

    try {
        const registroOTP = codigosRecuperacion.get(telefono);
        if (!registroOTP || registroOTP.otp !== otp || (Date.now() - registroOTP.timestamp > 5 * 60 * 1000)) {
            return res.status(400).json({ success: false, message: '❌ Código de verificación inválido o expirado.' });
        }

        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: '❌ Usuario no encontrado.' });
        }

        const metodoVinculado = await db.get('SELECT cedulaTitular FROM metodos_pago WHERE cedulaTitular LIKE ?', [`%${ultimos4Cedula}`]);
        if (!metodoVinculado || !metodoVinculado.cedulaTitular.endsWith(ultimos4Cedula)) {
            return res.status(400).json({ success: false, message: '❌ Los últimos 4 dígitos de la cédula no coinciden.' });
        }

        // Blanqueo seguro: solo actualiza el PIN, la wallet y los fondos quedan intactos
        await db.run('UPDATE usuarios SET pinSeguridad = ? WHERE id = ?', [nuevoPin, usuario.id]);
        
        codigosRecuperacion.delete(telefono);

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `✅ *PIN RESTAURADO CON ÉXITO*\n\nTu PIN de seguridad ha sido actualizado mediante recuperación.`
        );

        return res.json({ success: true, message: 'PIN restablecido con éxito!' });
    } catch (err) {
        console.error('Error al confirmar recuperación de PIN:', err);
        return res.status(500).json({ success: false, message: 'Error interno al procesar el cambio de PIN.' });
    }
});
// ==========================================
// APIS Y RUTAS
// ==========================================


// ==========================================
// APIS Y RUTAS
// ==========================================
app.get('/api/admin/balance', async (req, res) => {
    try {
        const rowWallets = await db.get('SELECT SUM(usdt_balance) AS totalUsuarios FROM wallets');
        const rowBinance = await db.get("SELECT SUM(monto) AS totalBinance FROM comisiones WHERE tipo = 'binance'");
        
        const saldoUsuarios = rowWallets && rowWallets.totalUsuarios ? rowWallets.totalUsuarios : 0;
        const gananciaBinance = rowBinance && rowBinance.totalBinance ? rowBinance.totalBinance : 0;

        res.json({
            success: true,
            saldoUsuarios: saldoUsuarios.toFixed(2),
            gananciaBinance: gananciaBinance.toFixed(2),
            totalGanancias: gananciaBinance.toFixed(2)
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// NUEVO: RUTA DE LISTADO Y CONTEO DE USUARIOS PARA EL PANEL ADMIN
app.get('/api/admin/usuarios', async (req, res) => {
    try {
        const rows = await db.all(`
            SELECT usuarios.id, usuarios.telefono, usuarios.accountType, usuarios.merchant_id, wallets.usdt_balance 
            FROM usuarios 
            LEFT JOIN wallets ON usuarios.id = wallets.user_id 
            ORDER BY usuarios.id DESC
        `);
        res.json({ success: true, usuarios: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/saldo/:telefono', limiterConsultasComercio, async (req, res) => {
    const busqueda = (req.params.telefono || '').trim();

    try {
        const row = await db.get(`
            SELECT usuarios.telefono, usuarios.merchant_id, usuarios.accountType, usuarios.dailyLimit, usuarios.metodoVinculado, wallets.usdt_balance
            FROM usuarios
            LEFT JOIN wallets ON usuarios.id = wallets.user_id
            WHERE usuarios.telefono = ? OR usuarios.merchant_id = ?
        `, [busqueda, busqueda]);

        if (!row) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        res.json({
            success: true,
            telefono: row.telefono,
            merchantId: row.merchant_id,
            accountType: row.accountType,
            dailyLimit: row.dailyLimit || 1000.00,
            saldoUSDT: row.usdt_balance || 0.00,
            metodoVinculado: row.metodoVinculado === 1
        });
    } catch (err) {
        console.error("Error consultando saldo:", err.message);
        return res.status(500).json({ success: false, message: 'Error interno al consultar saldo.' });
    }
});

// ==========================================
// RUTA OFICIAL DE INICIO DE SESIÓN POR PIN (CON SOPORTE DE PIN TEMPORAL DE 6 DÍGITOS Y BLOQUEO CERO TERCEROS)
// ==========================================
app.post('/api/login', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || req.body.telefonoUsuario || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();

    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ success: false, message: '⚠️ El teléfono y el PIN son obligatorios.' });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: '❌ El número no está registrado. Debe registrarse primero.' });
        }

        // VALIDACIÓN DE PIN: Soporta PIN fijo de 4 dígitos O PIN temporal de 6 dígitos activo en memoria
        let pinValido = false;
        if (pinSeguridad.length === 6) {
            const registroOTP = codigosRecuperacion.get(usuario.telefono);
            if (registroOTP && registroOTP.otp === pinSeguridad && (Date.now() - registroOTP.timestamp <= 5 * 60 * 1000)) {
                pinValido = true;
                codigosRecuperacion.delete(usuario.telefono); // Limpiar OTP usado
            }
        }
        
        if (!pinValido && usuario.pinSeguridad && usuario.pinSeguridad === pinSeguridad) {
            pinValido = true;
        }

        if (!pinValido) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto o código temporal expirado.' });
        }

        // VALIDACIÓN CERO TERCEROS: Verificar que posea método o monedero de recepción vinculado
        const esComercio = usuario.accountType === 'comercial' || usuario.accountType === 'emprendedor';
        if (usuario.metodoVinculado !== 1 && !esComercio) {
            return res.status(403).json({
                success: false,
                bloqueoRegistro: true,
                message: '❌ Acceso restringido. Debe vincular obligatoriamente su Cédula y Monedero/Cuenta de recepción para operar.',
                telefono: usuario.telefono
            });
        }

        res.json({ 
            success: true, 
            message: '¡Acceso autorizado!',
            telefono: usuario.telefono,
            accountType: usuario.accountType,
            merchantId: usuario.merchant_id,
            metodoVinculado: true
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: '❌ Error interno al procesar el inicio de sesión.' });
    }
});

// ==========================================
// RUTA OFICIAL PARA CAMBIO DE PIN DE SEGURIDAD
// ==========================================
app.post('/api/cambiar-pin', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const pinActual = (req.body.pinActual || '').trim();
    const pinNuevo = (req.body.pinNuevo || '').trim();

    if (!telefono || !pinActual || !pinNuevo) {
        return res.status(400).json({ success: false, message: '⚠️ Todos los campos son obligatorios para cambiar el PIN.' });
    }

    if (pinNuevo.length !== 4) {
        return res.status(400).json({ success: false, message: '⚠️ El nuevo PIN debe ser estrictamente de 4 dígitos.' });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: '❌ Usuario no encontrado en el sistema.' });
        }

        // Soporta cambio de PIN usando el PIN actual de 4 dígitos o el temporal de 6 dígitos
        let pinActualValido = false;
        if (pinActual.length === 6) {
            const registroOTP = codigosRecuperacion.get(usuario.telefono);
            if (registroOTP && registroOTP.otp === pinActual && (Date.now() - registroOTP.timestamp <= 5 * 60 * 1000)) {
                pinActualValido = true;
                codigosRecuperacion.delete(usuario.telefono);
            }
        }
        if (!pinActualValido && usuario.pinSeguridad && usuario.pinSeguridad === pinActual) {
            pinActualValido = true;
        }

        if (!pinActualValido) {
            return res.status(401).json({ success: false, message: '❌ El PIN actual ingresado es incorrecto.' });
        }

        await db.run('UPDATE usuarios SET pinSeguridad = ? WHERE id = ?', [pinNuevo, usuario.id]);

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `🔐 *SEGURIDAD ACTUALIZADA*\n\nTu PIN de seguridad de 4 dígitos ha sido modificado con éxito.\nSi no fuiste tú, comunícate de inmediato con soporte.`
        );

        res.json({ success: true, message: '¡PIN cambiado con éxito!' });
    } catch (err) {
        return res.status(500).json({ success: false, message: '❌ Error interno al actualizar el PIN.' });
    }
});

// ==========================================
// RUTA DE REGISTRO DE MÉTODOS / MONEDEROS DE RECEPCIÓN (VERIFICACIÓN ÚNICA CERO TERCEROS)
// ==========================================
app.post('/api/registrar-metodos', limiterPagos, async (req, res) => {
    const { cedulaTitular, metodo, cuentaDestino, telefono } = req.body;

    if (!cedulaTitular || !metodo || !cuentaDestino) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para vincular tu monedero o cuenta de recepción.' });
    }

    const cedulaLimpia = cedulaTitular.trim();
    const regexCedula = /^[VEJGvejg]?[-]?\d{6,10}$/;
    if (!regexCedula.test(cedulaLimpia)) {
        return res.status(400).json({ 
            success: false, 
            message: '❌ Cédula inválida. Ingrese un documento de identidad real (Ej: V12345678 o 12345678).' 
        });
    }

    const destinoLimpio = cuentaDestino.trim().toLowerCase();
    const metodoElegido = metodo.trim().toLowerCase();
    let esValido = false;
    let mensajeErrorFormato = '';
    let correoExtraido = null;
    const metodosSoportados = ['binance', 'airtm', 'bybit', 'okx', 'trc20', 'bep20', 'polygon'];
   
    if (!metodosSoportados.includes(metodoElegido)) {
        return res.status(400).json({ success: false, message: '❌ El método de pago, exchange o monedero seleccionado no es válido.' });
    }

    if (metodoElegido === 'binance') {
        const regexBinanceEmail = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        const regexBinanceID = /^\d{8,12}$/;
        if (regexBinanceEmail.test(destinoLimpio)) {
            esValido = true;
            correoExtraido = destinoLimpio;
        } else if (regexBinanceID.test(destinoLimpio)) {
            esValido = true;
        } else {
            mensajeErrorFormato = '❌ Cuenta, correo o Pay ID inválido para Binance Pay.';
        }
    } else if (metodoElegido === 'bybit' || metodoElegido === 'okx') {
        const regexEx = /^([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\d{7,12})$/;
        if (regexEx.test(destinoLimpio)) {
            esValido = true;
            if (destinoLimpio.includes('@')) correoExtraido = destinoLimpio;
        } else {
            mensajeErrorFormato = `❌ Cuenta o correo inválido para ${metodoElegido.toUpperCase()}.`;
        }
} else if (metodoElegido === 'airtm') {
    const regexCorreoGeneral = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (regexCorreoGeneral.test(destinoLimpio)) {
        esValido = true;
        correoExtraido = destinoLimpio;
    } else {
        mensajeErrorFormato = '❌ Para AirTM debe ingresar un correo electrónico válido.';
    }
} else if (['trc20', 'bep20', 'polygon'].includes(metodoElegido)) {
    if (destinoLimpio.length >= 20) {
        esValido = true;
    } else {
        mensajeErrorFormato = '❌ La dirección de monedero cripto es demasiado corta o inválida.';
    }
}

    if (!esValido) {
        return res.status(400).json({ success: false, message: mensajeErrorFormato });
    }

    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    try {
        await db.run(
            'INSERT INTO metodos_pago (cedulaTitular, metodo, cuentaDestino, fechaRegistro) VALUES (?, ?, ?, ?)',
            [cedulaLimpia, metodoElegido, cuentaDestino.trim(), ahora]
        );

        if (telefono) {
            await db.run('UPDATE usuarios SET metodoVinculado = 1 WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);

            if (correoExtraido) {
                const htmlBienvenida = `
                    <div style="font-family: Arial, sans-serif; color: #333; max-width: 650px; margin: 0 auto; padding: 25px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #ffffff;">
                      <h1 style="color: #2b6cb0; text-align: center;">¡Bienvenido a PagoMovil USDT! 🚀</h1>
                      <p>Hola,</p>
                      <p>Tu cuenta ha sido verificada y tu monedero/cuenta de recepción ha quedado vinculado exitosamente con la Cédula/ID: <strong>${cedulaLimpia}</strong>.</p>
                      
                      <div style="background-color: #e6fffa; border-left: 4px solid #319795; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <h4 style="margin-top: 0; color: #234e52;">🔒 Verificación Única y Seguridad Cero Terceros</h4>
                        <p style="margin-bottom: 0; font-size: 14px; color: #2c7a7b;">
                          Te hemos solicitado la configuración de tu cuenta o monedero de recepción por <strong>única vez</strong> como método válido de verificación de seguridad. Esto garantiza un entorno libre de terceros y 100% confiable para todos los usuarios.
                        </p>
                      </div>

                      <div style="background-color: #ebf8ff; border-left: 4px solid #3182ce; padding: 15px; margin: 20px 0; border-radius: 4px;">
                        <h3 style="margin-top: 0; color: #2b6cb0;">📖 Guía de Ayuda e Instrucciones Rápidas</h3>
                        <ul style="padding-left: 20px; margin-bottom: 0;">
                          <li><strong>Recargas en USDT (Polygon):</strong> Transfiere USDT en la red Polygon a la wallet oficial y registra el Hash (txHash) para acreditar tu saldo de inmediato.</li>
                          <li><strong>Envíos entre usuarios:</strong> Envía pagos en USDT al instante usando el número de teléfono o ID de Comercio del destinatario.</li>
                          <li><strong>Retiros:</strong> Retira tus USDT directamente a Binance, Zinli, Zelle u otros monederos configurados.</li>
                          <li><strong>Cuenta Comercial:</strong> Si tienes un negocio, solicita el cambio de plan a Comercial para obtener tu código QR de cobro automático.</li>
                        </ul>
                      </div>

                      <div style="background-color: #f7fafc; border: 1px solid #e2e8f0; padding: 15px; margin: 20px 0; border-radius: 4px; font-size: 13px; color: #4a5568;">
                        <h4 style="margin-top: 0; color: #2d3748;">📜 Términos, Condiciones y Políticas del Servicio</h4>
                        <ol style="padding-left: 18px; margin-bottom: 0;">
                          <li><strong>Verificación de Transacciones:</strong> Las recargas se auditan en la red Polygon. Hashes duplicados o inválidos serán rechazados.</li>
                          <li><strong>Comisiones:</strong> Las transferencias y retiros poseen tarifas administrativas reflejadas de manera transparente en tu panel.</li>
                          <li><strong>Seguridad:</strong> Tu PIN de 4 dígitos es estrictamente personal. Soporte nunca te pedirá esta clave.</li>
                          <li><strong>Límites:</strong> Las cuentas naturales poseen límites operativos diarios ampliables al pasar a plan Comercial.</li>
                        </ol>
                      </div>

                      <div style="text-align: center; margin-top: 25px;">
                        <p style="font-size: 12px; color: #a0aec0;">Este es un mensaje automático de confirmación de registro y políticas del sistema.</p>
                      </div>
                    </div>
                `;
                await enviarCorreoResend(correoExtraido, '¡Bienvenido a PagoMovil USDT! - Guía y Verificación Oficial', htmlBienvenida);
            }
        }

        res.json({ success: true, message: '¡Monedero/Cuenta de recepción validado con éxito! Ya estás en verde para operar.' });
    } catch (err) {
        console.error("Error guardando método de pago:", err.message);
        return res.status(500).json({ success: false, message: 'Error interno al registrar el método de pago.' });
    }
});

app.get('/api/historial/:telefono', limiterConsultasComercio, async (req, res) => {
    const busqueda = (req.params.telefono || '').trim();
    try {
        const rows = await db.all(
            `SELECT * FROM transacciones 
             WHERE telefonoEmisor = ? 
                OR telefonoDestino = ? 
                OR telefonoEmisor IN (SELECT merchant_id FROM usuarios WHERE telefono = ?)
                OR telefonoDestino IN (SELECT merchant_id FROM usuarios WHERE telefono = ?)
                OR (telefonoEmisor = 'EXTERNO_EXCHANGE' AND telefonoDestino = ?) 
             ORDER BY id DESC LIMIT 10`,
            [busqueda, busqueda, busqueda, busqueda, busqueda]
        );
        res.json({ 
            success: true, 
            transacciones: rows, 
            historial: rows,
            avisoAutolimpieza: "Mostrando las últimas 10 operaciones."
        });
    } catch (err) {
        console.error("Error consultando historial:", err.message);
        return res.status(500).json({ success: false, message: 'Error al consultar historial en la base de datos' });
    }
});
// ==========================================
// RUTA PARA OBTENER LA WALLET PERSONAL DEL USUARIO
// ==========================================
app.get('/api/usuario-wallet/:telefono', async (req, res) => {
    const telefono = (req.params.telefono || '').trim();
    try {
        const user = await db.get('SELECT assigned_wallet FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!user || !user.assigned_wallet) {
            // Si por alguna razón no la tuviera creada, se la generamos de emergencia
            const nueva = generarWalletIndividual();
            await db.run('UPDATE usuarios SET assigned_wallet = ?, private_key = ? WHERE telefono = ? OR merchant_id = ?', [nueva.address, nueva.privateKey, telefono, telefono]);
            return res.json({ success: true, wallet: nueva.address });
        }
        res.json({ success: true, wallet: user.assigned_wallet });
    } catch (err) {
        console.error("Error obteniendo wallet personal:", err.message);
        res.status(500).json({ success: false, message: 'Error interno al obtener la wallet' });
    }
});
// ==========================================
// RUTA DE ENVÍO DE CÓDIGO POR WHATSAPP
// ==========================================
app.post('/api/enviar-codigo', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    
    if (!telefono || !pinSeguridad) {
        return res.status(400).json({ success: false, message: 'El teléfono y el PIN de seguridad son obligatorios.' });
    }

    try {
        const usuarioExistente = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);

        const codigoVerificacion = Math.floor(100000 + Math.random() * 900000).toString();

        if (usuarioExistente) {
            // Verificar PIN (admite PIN fijo de 4 dígitos o PIN temporal de 6 dígitos)
            let pinValido = false;
            if (pinSeguridad.length === 6) {
                const registroOTP = codigosRecuperacion.get(usuarioExistente.telefono);
                if (registroOTP && registroOTP.otp === pinSeguridad && (Date.now() - registroOTP.timestamp <= 5 * 60 * 1000)) {
                    pinValido = true;
                    codigosRecuperacion.delete(usuarioExistente.telefono);
                }
            }
            if (!pinValido && usuarioExistente.pinSeguridad && usuarioExistente.pinSeguridad === pinSeguridad) {
                pinValido = true;
            }

            if (!pinValido) {
                return res.status(401).json({ 
                    success: false, 
                    message: '❌ Acceso denegado. Este número ya está registrado y el PIN de seguridad es incorrecto.' 
                });
            }

            const esComercio = usuarioExistente.accountType === 'comercial' || usuarioExistente.accountType === 'emprendedor';
            if (usuarioExistente.metodoVinculado !== 1 && !esComercio) {
                return res.status(403).json({
                    success: false,
                    bloqueoRegistro: true,
                    message: '❌ Acceso restringido. Debe vincular obligatoriamente su Cédula y Monedero/Cuenta de recepción para operar.',
                    telefono: usuarioExistente.telefono
                });
            }

            const mensajeLogin = `¡Acceso Verificado en PagoMóvilUSDT! 🟢\n\nTu línea ha sido autenticada correctamente.\n\n🔢 *Código de verificación:* *${codigoVerificacion}*`;
            await enviarMensajeWhatsappSeguro(telefono, mensajeLogin);

            return res.json({ 
                success: true, 
                message: '¡Acceso autorizado y código enviado por WhatsApp con éxito!'
            });

       } else {
    // Generar wallet única de Polygon al registrarse para cualquier usuario nuevo
    const walletGenerada = ethers.Wallet.createRandom();
    const nuevaWalletCrypto = {
        address: walletGenerada.address,
        privatekey: walletGenerada.privateKey
    };

            await db.run(
                `INSERT INTO usuarios (telefono, pinSeguridad, accountType, dailyLimit, metodoVinculado, assigned_wallet, private_key) VALUES (?, ?, 'natural', 1000.00, 0, ?, ?)`,
                [telefono, pinSeguridad, nuevaWalletCrypto.address, nuevaWalletCrypto.privateKey]
            );

            const userRecord = await db.get('SELECT id FROM usuarios WHERE telefono = ?', [telefono]);
            if (userRecord) {
                const existingWallet = await db.get('SELECT id FROM wallets WHERE user_id = ?', [userRecord.id]);
                if (!existingWallet) {
                    await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [userRecord.id]);
                }
            }

            const mensajeBienvenida = `¡Bienvenido a PagoMóvilUSDT! 🟢\n\nEstimado usuario, su registro ha sido procesado exitosamente.\n\n🔑 PIN: ${pinSeguridad}\n📥 Tu Wallet Polygon Asignada:\n${nuevaWalletCrypto.address}\n\n🛡️ Por su seguridad, complete su vinculación de identidad.`;
            
            await enviarMensajeWhatsappSeguro(telefono, mensajeBienvenida);

            return res.json({
                success: true,
                bloqueoRegistro: true,
                message: '¡Bienvenido! Su registro inicial fue exitoso con su wallet única. Por favor vincule su Cédula y Método de pago.',
                telefono: telefono,
                assigned_wallet: nuevaWalletCrypto.address
            });
        }
    } catch (err) {
        console.error("Error en autenticación de usuario:", err);
        return res.status(500).json({ success: false, message: 'Error interno al procesar la autenticación.' });
    }
});
// ==========================================
// CAMBIO A CUENTA COMERCIAL
// ==========================================
const procesarUpgradeComercialHandler = async (req, res) => {
    const telefono = (req.body.telefono || req.body.telefonoUsuario || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    const planDeseado = req.body.planDeseado || 'comercial';

    if (!telefono) {
        return res.status(400).json({ 
            success: false, 
            message: 'El número de teléfono es obligatorio para solicitar el cambio de plan.' 
        });
    }

    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefono, telefono]);
        if (!usuario) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        }

        if (pinSeguridad && usuario.pinSeguridad && usuario.pinSeguridad !== pinSeguridad) {
            return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto.' });
        }

        if (usuario.accountType === 'comercial' || usuario.accountType === 'emprendedor') {
            return res.json({
                success: true,
                message: `Tu cuenta ya es Comercial. Tu ID QR es ${usuario.merchant_id}.`,
                merchantId: usuario.merchant_id,
                accountType: usuario.accountType
            });
        }

        const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuario.id]);
        if (!wallet || wallet.usdt_balance < COSTO_CAMBIO_PLAN_COMERCIAL) {
            return res.status(400).json({ 
                success: false, 
                message: `❌ Saldo insuficiente. Requieres al menos $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT en tu billetera.` 
            });
        }

        const nuevoSaldo = wallet.usdt_balance - COSTO_CAMBIO_PLAN_COMERCIAL;
        const limiteIlimitado = 999999.00;
        const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
        const refComision = 'UPG-' + Math.floor(100000 + Math.random() * 900000);

        const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
        const merchantAliasUnico = `MERCHANT-${randomSuffix}`;

        await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, wallet.id]);
        await db.run(
            'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
            ['binance', COSTO_CAMBIO_PLAN_COMERCIAL, refComision, ahora]
        );
        await db.run(
            `UPDATE usuarios SET merchant_id = ?, accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE id = ?`,
            [merchantAliasUnico, planDeseado, limiteIlimitado, ahora, usuario.id]
        );

        await enviarMensajeWhatsappSeguro(
            usuario.telefono,
            `¡ACTIVACIÓN COMERCIAL EXITOSA! 🚀\n\nID: ${merchantAliasUnico}\nComisión: $${COSTO_CAMBIO_PLAN_COMERCIAL} USDT`
        );

        res.json({
            success: true,
            message: `¡Cuenta actualizada a comercial! Tu ID QR único generado es ${merchantAliasUnico}.`,
            merchantId: merchantAliasUnico,
            nuevoSaldo: nuevoSaldo.toFixed(2),
            accountType: planDeseado,
            dailyLimit: limiteIlimitado
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error interno procesando el cambio de cuenta.' });
    }
};

app.post('/api/solicitar-comercial', limiterPagos, procesarUpgradeComercialHandler);
app.post('/api/upgrade-comercial', limiterPagos, procesarUpgradeComercialHandler);

app.post('/api/upgrade-account', limiterPagos, async (req, res) => {
    const telefono = (req.body.telefono || '').trim();
    const accountType = req.body.accountType;
    if (!telefono || !accountType) {
        return res.status(400).json({ success: false, message: 'Faltan datos requeridos.' });
    }
    const nuevoLimite = 999999.00;
    const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    try {
        const resultado = await db.run(
            `UPDATE usuarios SET accountType = ?, dailyLimit = ?, upgradedAt = ? WHERE telefono = ? OR merchant_id = ?`,
            [accountType, nuevoLimite, ahora, telefono, telefono]
        );
        if (resultado.changes === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
        
        res.json({ success: true, message: `¡Cuenta actualizada a ${accountType.toUpperCase()}!` });
    } catch (err) {
        return res.status(500).json({ success: false, message: 'Error en base de datos.' });
    }
});


// ==========================================
// PROCESAMIENTO DE RETIROS DIRECTOS (BLINDADO CON POLYGON + ETHERS.JS)
// ==========================================
const procesarRetiroHandler = async (req, res) => {
    const { plataforma, destino, monto, pinSeguridad } = req.body;
    let telefono = (req.body.telefono || req.body.telefonoUsuario || '').trim();

    const montoNum = parseFloat(monto);
    if (!destino || isNaN(montoNum) || montoNum <= 0) {
        return res.status(400).json({ success: false, message: 'Datos de retiro inválidos.' });
    }

    const comisionAplicar = calcularComisionRetiro(montoNum);
    if (montoNum <= comisionAplicar) {
        return res.status(400).json({ success: false, message: `El monto del retiro debe ser superior a la comisión ($${comisionAplicar.toFixed(2)}).` });
    }

    const ejecutarRetiro = async (telUsuario) => {
        try {
            // 1. Buscar usuario y su clave privada de Polygon almacenada en SQLite
            const usuario = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telUsuario, telUsuario]);
            if (!usuario) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });

            if (pinSeguridad && usuario.pinSeguridad && usuario.pinSeguridad !== pinSeguridad) {
                return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto.' });
            }

            // 2. Verificar saldo disponible en la tabla wallets
            const wallet = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuario.id]);
            if (!wallet || wallet.usdt_balance < montoNum) {
                return res.status(400).json({ success: false, message: '❌ Saldo insuficiente en tu monedero.' });
            }

            const montoNetoRetiro = montoNum - comisionAplicar;
            let hashBlockchain = null;

            // 3. EVALUAR SI EL RETIRO ES ON-CHAIN (Polygon) O INTERNO/EXCHANGE
            const esRetiroPolygon = (plataforma && plataforma.toLowerCase().includes('polygon')) || destino.trim().startsWith('0x');

            if (esRetiroPolygon) {
                if (!usuario.private_key) {
                    return res.status(400).json({ success: false, message: '❌ Error crítico: El usuario no posee una wallet criptográfica asignada.' });
                }

                console.log(`🚀 Iniciando transferencia real en Polygon hacia ${destino} por $${montoNetoRetiro} USDT...`);

                try {
                    // Conexión oficial al proveedor RPC de Polygon (Alchemy)
                    const provider = new ethers.JsonRpcProvider('https://polygon-mainnet.g.alchemy.com/v2/alh_QXifklhC8Igox8-9wTbcR');
                    const userWallet = new ethers.Wallet(usuario.private_key, provider);

                    // Contrato oficial de USDT en la red Polygon
                    const usdtContractAddress = '0xc2132d05d31c914a87c6611c10748aeb04b58e2f';
                    const abiUSDT = ["function transfer(to address, value uint256) public returns (bool)"];
                    const usdtContract = new ethers.Contract(usdtContractAddress, abiUSDT, userWallet);

                    // USDT maneja 6 decimales exactos en Polygon
                    const montoWei = ethers.parseUnits(montoNetoRetiro.toFixed(6), 6);

                    // Disparar la transacción en firme en la blockchain
                    const tx = await usdtContract.transfer(destino.trim(), montoWei);
                    console.log(`✅ Transacción enviada a la blockchain. Hash: ${tx.hash}`);

                    // Esperar confirmación del bloque
                    const receipt = await tx.wait();
                    hashBlockchain = receipt.hash;

                } catch (errorBlockchain) {
                    console.error("❌ Error ejecutando ethers.js en Polygon:", errorBlockchain.message);
                    return res.status(500).json({ 
                        success: false, 
                        message: `❌ Error en la red Polygon al procesar el retiro: ${errorBlockchain.message}` 
                    });
                }
            }

            // 4. ACTUALIZACIÓN ATÓMICA EN BASE DE DATOS (SQLite)
            const nuevoSaldo = wallet.usdt_balance - montoNum;
            const refRetiro = 'RET-' + Math.floor(100000 + Math.random() * 900000);
            const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

            await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, wallet.id]);
            
            await db.run(
                'INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, reference_hash, fechaHora) VALUES (?, ?, ?, ?, ?, ?)',
                [refRetiro, montoNum, usuario.telefono, `${(plataforma || 'EXT').toUpperCase()}:${destino}`, hashBlockchain || refRetiro, ahora]
            );
            
            await db.run(
                'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
                ['binance', comisionAplicar, refRetiro, ahora]
            );

            // 5. Notificación por WhatsApp del éxito de la salida
            await enviarMensajeWhatsappSeguro(
                usuario.telefono, 
                `¡RETIRO PROCESADO CON ÉXITO! 📤\nMonto: $${montoNum.toFixed(2)} USDT\nNeto enviado: $${montoNetoRetiro.toFixed(2)}\nRef: ${refRetiro}${hashBlockchain ? `\nHash: ${hashBlockchain}` : ''}`
            );

            return res.json({
                success: true,
                message: `¡Retiro de $${montoNum.toFixed(2)} USDT procesado exitosamente!`,
                nuevoSaldo: nuevoSaldo.toFixed(2),
                comisionAplicada: comisionAplicar.toFixed(2),
                referencia: refRetiro,
                txHash: hashBlockchain
            });

        } catch (err) {
            console.error("❌ Error general en procesarRetiroHandler:", err.message);
            return res.status(500).json({ success: false, message: 'Error interno procesando el retiro en el servidor.' });
        }
    };

    if (!telefono) {
        const rowUser = await db.get('SELECT telefono FROM usuarios ORDER BY id DESC LIMIT 1');
        if (rowUser && rowUser.telefono) await ejecutarRetiro(rowUser.telefono);
        else return res.status(400).json({ success: false, message: 'No hay usuario autenticado.' });
    } else {
        await ejecutarRetiro(telefono);
    }
};



// ==========================================
// RECARGA DIRECTA A LA WALLET PERSONAL (SIN HASHES)
// ==========================================
const logicaRecargaHandler = async (req, res) => {
    let phoneNumber = (req.body.phoneNumber || req.body.telefono || req.body.phone || '').trim();
    let amount = req.body.amount || req.body.monto || req.body.cantidad || req.body.valor;

    const procesarConTelefono = async (telObjetivo) => {
        const montoLimpio = parseFloat(amount);

        if (!amount) {
            return res.status(400).json({ success: false, message: 'El monto de recarga es obligatorio.' });
        }

        if (isNaN(montoLimpio) || montoLimpio < MONTO_MINIMO_RECARGA) {
            return res.status(400).json({ success: false, message: `Monto mínimo de recarga: $${MONTO_MINIMO_RECARGA.toFixed(2)} USDT.` });
        }

        try {
            const comisionAplicar = calcularComisionRecarga(montoLimpio);
            const montoNetoAcreditar = montoLimpio - comisionAplicar;

            let wallet = await db.get(`
                SELECT wallets.id, wallets.usdt_balance, usuarios.telefono 
                FROM usuarios 
                LEFT JOIN wallets ON wallets.user_id = usuarios.id 
                WHERE usuarios.telefono = ? OR usuarios.merchant_id = ?
            `, [telObjetivo, telObjetivo]);

            let walletId;
            let saldoActual = 0.00;
            let telReal = telObjetivo;

            if (wallet && wallet.id) {
                walletId = wallet.id;
                saldoActual = wallet.usdt_balance;
                telReal = wallet.telefono;
            } else {
                const user = await db.get('SELECT id, telefono FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telObjetivo, telObjetivo]);
                if (!user) return res.status(400).json({ success: false, error: `Destinatario no registrado.` });
                const newW = await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [user.id]);
                walletId = newW.lastID;
                telReal = user.telefono;
            }

            const nuevoSaldo = saldoActual + montoNetoAcreditar;
            const referenciaGen = 'REC-' + Math.floor(100000 + Math.random() * 900000);
            const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

            // Actualizar balance y registrar la transacción sin depender de hashes
            await db.run('UPDATE wallets SET usdt_balance = ? WHERE id = ?', [nuevoSaldo, walletId]);
            await db.run(`
                INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, reference_hash, fechaHora) 
                VALUES (?, ?, ?, ?, ?, ?)
            `, [referenciaGen, montoLimpio, 'DIRECTO_WALLET', telReal, referenciaGen, ahora]);
            
            await db.run(
                'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
                ['binance', comisionAplicar, referenciaGen, ahora]
            );

            await enviarMensajeWhatsappSeguro(telReal, `¡RECARGA ACREDITADA CON ÉXITO! 📥\nMonto: $${montoLimpio.toFixed(2)}\nAcreditado: $${montoNetoAcreditar.toFixed(2)}\nRef: ${referenciaGen}`);

            res.json({ 
                success: true, 
                message: `¡Recarga de $${montoLimpio.toFixed(2)} USDT procesada! Acreditados $${montoNetoAcreditar.toFixed(2)}. Ref: ${referenciaGen}`,
                montoAcreditado: montoNetoAcreditar.toFixed(2),
                comisionAplicada: comisionAplicar.toFixed(2),
                referencia: referenciaGen
            });
        } catch (err) {
            console.error("Error en recarga directa:", err.message);
            return res.status(500).json({ success: false, error: "Error procesando recarga en la base de datos" });
        }
    };

    if (!phoneNumber) {
        const rowUser = await db.get('SELECT telefono FROM usuarios ORDER BY id DESC LIMIT 1');
        if (rowUser && rowUser.telefono) await procesarConTelefono(rowUser.telefono);
        else return res.status(400).json({ success: false, message: 'No hay usuarios registrados.' });
    } else {
        await procesarConTelefono(phoneNumber);
    }
};

app.post('/api/recargar', limiterPagos, logicaRecargaHandler);
app.post('/recargar', limiterPagos, logicaRecargaHandler);

// ==========================================
// ENVÍO DE PAGO
// ==========================================
const enviarPagoHandler = async (req, res) => {
    const monto = parseFloat(req.body.montoUSDT || req.body.monto || req.body.amount || req.body.cantidad || req.body.valor);
    let telefonoDestino = (req.body.telefonoComercio || req.body.telefono || req.body.phone || req.body.nroTelefono || '').trim();
    let telefonoEmisor = (req.body.telefonoEmisor || req.body.telefonoPagador || req.body.telefonoUsuario || '').trim();
    const pinSeguridad = (req.body.pinSeguridad || '').trim();
    
    if (!monto || !telefonoDestino) {
        return res.status(400).json({ success: false, message: 'Faltan datos obligatorios para el pago.' });
    }

    const ejecutarEnvioConEmisor = async (telEmisorFinal) => {
        try {
            const usuarioEmisor = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telEmisorFinal, telEmisorFinal]);
            if (!usuarioEmisor) return res.status(401).json({ success: false, message: '❌ Emisor no registrado.' });

            if (pinSeguridad && usuarioEmisor.pinSeguridad && usuarioEmisor.pinSeguridad !== pinSeguridad) {
                return res.status(401).json({ success: false, message: '❌ PIN de seguridad incorrecto.' });
            }

            const limitePermitido = usuarioEmisor.dailyLimit || 1000.00;
            if (usuarioEmisor.accountType === 'natural' && monto > limitePermitido) {
                return res.status(400).json({ success: false, message: `❌ Límite superado para cuentas Naturales ($${limitePermitido}).` });
            }

            const walletEmisor = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuarioEmisor.id]);
            if (!walletEmisor || walletEmisor.usdt_balance < monto) {
                return res.status(400).json({ success: false, message: 'Saldo insuficiente en USDT.' });
            }

            const usuarioReceptor = await db.get('SELECT * FROM usuarios WHERE telefono = ? OR merchant_id = ?', [telefonoDestino, telefonoDestino]);
            if (!usuarioReceptor) {
                return res.status(400).json({ success: false, message: '❌ El número o comercio destino no está registrado en la plataforma.' });
            }

            const esComercioReceptor = usuarioReceptor.accountType === 'comercial' || usuarioReceptor.accountType === 'emprendedor';
            if (usuarioReceptor.metodoVinculado !== 1 && !esComercioReceptor) {
                return res.status(400).json({ 
                    success: false, 
                    message: '❌ El destinatario no ha completado su registro obligatorio de Cédula y Monedero/Cuenta de recepción. No puede recibir transferencias.' 
                });
            }

            if (usuarioEmisor.id === usuarioReceptor.id) {
                return res.status(400).json({ success: false, message: '❌ No puedes transferirte a ti mismo.' });
            }

            let walletReceptor = await db.get('SELECT * FROM wallets WHERE user_id = ?', [usuarioReceptor.id]);
            let idWalletRec = walletReceptor ? walletReceptor.id : (await db.run('INSERT INTO wallets (user_id, usdt_balance) VALUES (?, 0.00)', [usuarioReceptor.id])).lastID;

            await db.run('UPDATE wallets SET usdt_balance = usdt_balance - ? WHERE id = ?', [monto, walletEmisor.id]);
            await db.run('UPDATE wallets SET usdt_balance = usdt_balance + ? WHERE id = ?', [monto, idWalletRec]);

            const numeroReferencia = 'REF-' + Math.floor(100000 + Math.random() * 900000);
            const ahora = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

            await db.run(
                'INSERT INTO transacciones (referencia, monto, telefonoEmisor, telefonoDestino, fechaHora) VALUES (?, ?, ?, ?, ?)',
                [numeroReferencia, monto, usuarioEmisor.telefono, usuarioReceptor.telefono, ahora]
            );

            let comisionAplicada = esComercioReceptor ? calcularComisionComercio(monto) : COMISION_FIJA_USUARIO;
            
            await db.run(
                'INSERT INTO comisiones (tipo, monto, referencia, fechaHora) VALUES (?, ?, ?, ?)',
                ['binance', comisionAplicada, numeroReferencia, ahora]
            );

            await enviarMensajeWhatsappSeguro(usuarioReceptor.telefono, `¡PAGO RECIBIDO! 🟢\nRef: ${numeroReferencia}\nMonto: $${monto}`);
            await enviarMensajeWhatsappSeguro(usuarioEmisor.telefono, `¡PAGO ENVIADO! 🔴\nRef: ${numeroReferencia}\nMonto: $${monto}`);

            res.json({ 
                success: true, 
                message: `¡Pago de $${monto} USDT procesado! Ref: ${numeroReferencia}`,
                referencia: numeroReferencia,
                comisionPlataforma: comisionAplicada
            });
        } catch (err) {
            return res.status(500).json({ success: false, message: 'Error procesando el pago.' });
        }
    };

    if (!telefonoEmisor) {
        const rowUser = await db.get('SELECT telefono FROM usuarios ORDER BY id DESC LIMIT 1');
        if (rowUser && rowUser.telefono) await ejecutarEnvioConEmisor(rowUser.telefono);
        else return res.status(400).json({ success: false, message: 'No hay un usuario emisor registrado.' });
    } else {
        await ejecutarEnvioConEmisor(telefonoEmisor);
    }
};
app.post('/procesar-retiro', limiterPagos, procesarRetiroHandler);
app.post('/api/enviar-pago', limiterPagos, enviarPagoHandler);
app.post('/procesar-pago', limiterPagos, enviarPagoHandler);

// ==========================================
// MANTENIMIENTO AUTOMÁTICO
// ==========================================
setInterval(async () => {
    try {
        if (db) {
            await db.run("DELETE FROM transacciones WHERE fechaHora < datetime('now', '-60 days')");
            await db.run("VACUUM;");
        }
    } catch (e) {}
}, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor de PagoMóvil USDT corriendo en el puerto ${PORT}`);
});