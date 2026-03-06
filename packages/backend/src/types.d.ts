declare module "polka" {
  import { IncomingMessage, ServerResponse } from "node:http";

  interface Polka {
    use(...handlers: any[]): Polka;
    get(path: string, ...handlers: any[]): Polka;
    post(path: string, ...handlers: any[]): Polka;
    put(path: string, ...handlers: any[]): Polka;
    patch(path: string, ...handlers: any[]): Polka;
    delete(path: string, ...handlers: any[]): Polka;
    options(path: string, ...handlers: any[]): Polka;
    head(path: string, ...handlers: any[]): Polka;
    all(path: string, ...handlers: any[]): Polka;
    handler: (req: IncomingMessage, res: ServerResponse) => void;
    listen(port: number, callback?: () => void): Polka;
    server: any;
  }

  function polka(options?: any): Polka;
  export = polka;
}
