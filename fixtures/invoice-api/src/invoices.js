const invoices = [
  { id: "INV-1001", customerId: "CUST-1", status: "open", totalCents: 12500 },
  { id: "INV-1002", customerId: "CUST-1", status: "paid", totalCents: 9900 },
  { id: "INV-1003", customerId: "CUST-2", status: "open", totalCents: 4500 },
];

export function listInvoices(filters = {}) {
  return invoices.filter((invoice) => {
    if (filters.status && invoice.status !== filters.status) {
      return false;
    }

    if (filters.customerId && invoice.customerId !== filters.customerId) {
      return false;
    }

    return true;
  });
}

export function getInvoiceById(id) {
  return invoices.find((invoice) => invoice.id === id) ?? null;
}

export function getInvoiceSummary() {
  const openInvoices = invoices.filter((invoice) => invoice.status === "open");

  return {
    count: invoices.length,
    openCount: openInvoices.length,
    paidCount: invoices.filter((invoice) => invoice.status === "paid").length,
    totalOpenCents: openInvoices.reduce(
      (total, invoice) => total + invoice.totalCents,
      0,
    ),
  };
}
