// public/client-payment.js - Reliable PayPal button rendering

window.renderPayPalButton = function() {
    const container = document.getElementById('paypal-button-container');
    if (!container) return;
    // Clear loading spinner
    container.innerHTML = '';
    try {
        window.paypal.Buttons({
            createOrder: async () => {
                const amountInput = document.getElementById('amountInput');
                let amount = parseFloat(amountInput.value);
                if (isNaN(amount) || amount < 1) amount = 5.00;
                if (amount > 1000) amount = 1000.00;
                const response = await fetch('/api/create-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount: amount.toFixed(2) })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Failed to create order');
                return data.orderId;
            },
            onApprove: async (data) => {
                const response = await fetch('/api/capture-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId: data.orderID })
                });
                const result = await response.json();
                if (response.ok) {
                    document.getElementById('paymentStatus').innerHTML = '<div class="success-message">Payment successful! Thank you.</div>';
                    container.style.display = 'none';
                } else {
                    throw new Error(result.error || 'Capture failed');
                }
            },
            onError: (err) => {
                console.error('PayPal error:', err);
                document.getElementById('paymentStatus').innerHTML = '<div class="error-message">Payment failed. Please try again.</div>';
                // Re-show loading spinner? Not needed.
            }
        }).render('#paypal-button-container');
    } catch (err) {
        console.error('Button render error:', err);
        container.innerHTML = '<div class="error-message">Failed to load payment button. Please refresh the page.</div>';
    }
};

// If PayPal SDK already loaded, render immediately; otherwise wait for onload
if (window.paypalLoaded) {
    window.renderPayPalButton();
} else {
    // Fallback: also poll for a few seconds in case onload doesn't fire
    let attempts = 0;
    const interval = setInterval(() => {
        attempts++;
        if (window.paypal) {
            clearInterval(interval);
            window.renderPayPalButton();
        } else if (attempts > 50) { // 5 seconds
            clearInterval(interval);
            document.getElementById('paypal-button-container').innerHTML = '<div class="error-message">PayPal SDK failed to load. Check your internet connection and Client ID.</div>';
        }
    }, 100);
}