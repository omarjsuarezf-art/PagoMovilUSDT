// Módulo de Recarga de Saldo en USDT
const express = require('express');
const router = express.Router();

// Función para procesar una recarga de saldo en USDT usando números de teléfono
async function procesarRecargaUSDT(phoneNumber, amount, txHash, clientDb) {
    const trx = await clientDb.transaction();

    try {
        // 1. Verificar si ya existe un registro con este Hash para evitar doble cobro (fraude)
        const txExistente = await trx('transactions')
            .where('reference_hash', txHash)
            .first();

        if (txExistente) {
            throw new Error("Esta transacción ya fue procesada anteriormente.");
        }

        // 2. Buscar la billetera del usuario por su número de teléfono
        const wallet = await trx('wallets')
            .join('users', 'wallets.user_id', 'users.id')
            .where('users.phone_number', phoneNumber)
            .select('wallets.id', 'wallets.usdt_balance')
            .first();

        if (!wallet) {
            throw new Error("El número de teléfono no está registrado en la plataforma.");
        }

        // 3. Sumar el monto recargado al saldo actual del usuario (convertido a número de forma segura)
        const montoNumerico = Number(amount);
        await trx('wallets')
            .where('id', wallet.id)
            .increment('usdt_balance', montoNumerico);

        // 4. Guardar el registro de la recarga en la base de datos
        await trx('transactions').insert({
            sender_phone: "EXTERNO_DEPOSITO",
            receiver_phone: phoneNumber,
            amount: montoNumerico,
            fee_collected: 0, // Recargas libres de comisión
            status: 'completed',
            reference_hash: txHash,
            timestamp: new Date()
        });

        await trx.commit();
        return { success: true, message: `¡Recarga exitosa de ${montoNumerico} USDT acreditada!` };

    } catch (error) {
        await trx.rollback();
        return { success: false, error: error.message };
    }
}

// Ruta POST para procesar la recarga (ajustada para recibir los datos de manera limpia)
router.post('/recargar', async (req, res) => {
    try {
        const { phoneNumber, amount, txHash } = req.body;
        
        if (!phoneNumber || !amount || !txHash) {
            return res.status(400).json({ success: false, error: "Faltan datos obligatorios para procesar la recarga." });
        }

        const resultado = await procesarRecargaUSDT(phoneNumber, amount, txHash, req.db);
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ success: false, error: "Error interno procesando la recarga" });
    }
});

// Ruta GET para consultar el historial de recargas y movimientos por teléfono
router.get('/historial/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        
        if (!phone) {
            return res.status(400).json({ success: false, error: "Teléfono no proporcionado." });
        }

        // Buscamos las transacciones asociadas a ese número (como receptor o emisor)
        const transacciones = await req.db('transactions')
            .where('receiver_phone', phone)
            .orWhere('sender_phone', phone)
            .orderBy('timestamp', 'desc')
            .limit(15);

        res.json({ success: true, transacciones });
    } catch (err) {
        console.error("Error consultando historial:", err);
        res.status(500).json({ success: false, error: "Error interno al obtener el historial" });
    }
});

// Exportar el router para Express
module.exports = router;