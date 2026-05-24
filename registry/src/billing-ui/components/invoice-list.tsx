"use client";

/**
 * <InvoiceList /> — paginated invoice history.
 *
 * Forked from billingsdk's invoice-history (MIT). Binds to Parcae's
 * `Invoice` model via `useQuery`.
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@dollhousestudio/ui/components/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@dollhousestudio/ui/components/table";
import { Badge } from "@dollhousestudio/ui/components/badge";
import { Button } from "@dollhousestudio/ui/components/button";
import { cn } from "@dollhousestudio/ui/lib/cn";
import { CalendarDays, Download, ReceiptText } from "lucide-react";
import type { InvoiceItem } from "../lib/billing-transformers";

export interface InvoiceListProps {
  invoices: InvoiceItem[];
  className?: string;
  title?: string;
  description?: string;
  loading?: boolean;
  onDownload?: (invoiceId: string) => void;
}

function statusBadge(status: InvoiceItem["status"]) {
  switch (status) {
    case "paid":
      return (
        <Badge className="border-emerald-700/40 bg-emerald-600 text-emerald-50">
          Paid
        </Badge>
      );
    case "refunded":
      return <Badge variant="secondary">Refunded</Badge>;
    case "open":
      return <Badge variant="outline">Open</Badge>;
    case "void":
      return <Badge variant="outline">Void</Badge>;
  }
}

export function InvoiceList({
  invoices,
  className,
  title = "Invoice history",
  description = "Your past invoices and payment receipts.",
  loading,
  onDownload,
}: InvoiceListProps) {
  return (
    <Card className={cn("w-full", className)}>
      {(title || description) && (
        <CardHeader className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg font-medium">
            <ReceiptText className="h-4 w-4 text-primary" />
            {title}
          </CardTitle>
          {description && (
            <CardDescription className="text-sm text-muted-foreground">
              {description}
            </CardDescription>
          )}
        </CardHeader>
      )}
      <CardContent>
        <Table>
          <TableCaption className="sr-only">
            List of past invoices with dates, amounts, status, and download
            actions.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">Date</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(loading || !invoices || invoices.length === 0) && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  {loading ? "Loading…" : "No invoices yet"}
                </TableCell>
              </TableRow>
            )}
            {invoices?.map((inv) => (
              <TableRow key={inv.id} className="group">
                <TableCell className="text-muted-foreground">
                  <div className="inline-flex items-center gap-2">
                    <CalendarDays className="h-3.5 w-3.5" />
                    {inv.date}
                  </div>
                </TableCell>
                <TableCell className="max-w-[320px]">
                  <div
                    className="truncate"
                    title={inv.description || "Invoice"}
                  >
                    {inv.description || "Invoice"}
                  </div>
                </TableCell>
                <TableCell className="text-right font-medium">
                  {inv.amount}
                </TableCell>
                <TableCell className="text-right">
                  {statusBadge(inv.status)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() =>
                      inv.invoiceUrl
                        ? window.open(
                            inv.invoiceUrl,
                            "_blank",
                            "noopener,noreferrer",
                          )
                        : onDownload?.(inv.id)
                    }
                    aria-label={`Download invoice ${inv.id}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
