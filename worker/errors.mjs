export class ApiError extends Error {
  constructor(message,status=400,code='invalid-input'){super(message);this.status=status;this.code=code;}
}
export const fail=(message,status=400,code)=>{throw new ApiError(message,status,code);};
