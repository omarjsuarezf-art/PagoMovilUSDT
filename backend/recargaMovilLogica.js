const express = require('express');
const router = express.Router();

// Módulo de Recarga de Saldo en USDT
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

        // 3. Sumar el monto recargado al saldo actual del usuario
        await trx('wallets')
            .where('id', wallet.id)
            .increment('usdt_balance', amount);

        // 4. Guardar el registro de la recarga en la base de datos
        await trx('transactions').insert({
            sender_phone: "EXTERNO_DEPOSITO",
            receiver_phone: phoneNumber,
            amount: amount,
            fee_collected: 0, // Las recargas suelen ser libres de comisión para incentivar el uso
            status: 'completed',
            reference_hash: txHash,
            timestamp: new Date()
        });

        await trx.commit();
        return { success: true, message: `¡Recarga exitosa de ${amount} USDT acreditada!` };

    } catch (error) {
        await trx.rollback();
        return { success: false, error: error.message };
    }
}

// Ruta POST para procesar la recarga
router.post('/recargar', async (req, res) => {
    try {
        const { phoneNumber, amount, txHash } = req.body;
        const resultado = await procesarRecargaUSDT(phoneNumber, amount, txHash, req.db);
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ success: false, error: "Error interno procesando la recarga" });
    }
});

// Exportar el router para Express
module.exports = router;